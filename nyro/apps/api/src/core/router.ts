/**
 * NYRO Model Router (spec §9, §10, §11, §101).
 *
 * A PURE FUNCTION: (candidate models, request) -> ranked decision.
 * No I/O, no clock, no randomness. That is what makes the privacy and mode
 * guarantees testable rather than aspirational — see test/router.test.ts.
 *
 * It returns a RANKED LIST, not a single winner. The ranking *is* the fallback
 * chain (§11), which is why fallback needs no separate policy: anything the
 * router refused on privacy or cost grounds is not in the list at all, so the
 * executor cannot accidentally escalate to it.
 */
import type {
  Capability,
  RegisteredModel,
  RoutingCandidate,
  RoutingDecision,
  RoutingRequest,
} from "./types.ts";

/** Output tokens we assume when sizing context headroom. */
const CONTEXT_HEADROOM = 512;

interface Weights {
  quality: number;
  speed: number;
  cost: number;
}

/** Mode → what the score optimises for (spec §10). */
function weightsFor(mode: RoutingRequest["mode"]): Weights {
  switch (mode) {
    case "cheapest":
      return { quality: 0.15, speed: 0.1, cost: 0.75 };
    case "fastest":
      return { quality: 0.15, speed: 0.75, cost: 0.1 };
    case "best":
      return { quality: 0.9, speed: 0.05, cost: 0.05 };
    // auto / local_only / cloud_only / manual all use a balanced profile; the
    // mode's real work is done by the eligibility filter below, not the weights.
    default:
      return { quality: 0.5, speed: 0.25, cost: 0.25 };
  }
}

/**
 * How well a model serves the requested capabilities, 0..10.
 * A capability the model lacks is a hard filter (below), so this only grades
 * models that already qualify.
 */
function qualityScore(model: RegisteredModel, wanted: Capability[]): number {
  const s = model.scores;
  const relevant: number[] = [];
  for (const cap of wanted) {
    if (cap === "coding") relevant.push(s.coding);
    else if (cap === "reasoning") relevant.push(s.reasoning);
    else if (cap === "vision") relevant.push(s.vision);
    else if (cap === "tool_calling") relevant.push(s.tool_calling);
  }
  if (relevant.length === 0) {
    // No quality-bearing capability asked for: general competence.
    return (s.reasoning + s.coding) / 2;
  }
  // The weakest relevant skill dominates — a model that cannot see is not
  // rescued by being a great coder when the task needs vision.
  return Math.min(...relevant) * 0.6 + (relevant.reduce((a, b) => a + b, 0) / relevant.length) * 0.4;
}

function estimateCostUsd(model: RegisteredModel, req: RoutingRequest): number {
  return (
    (req.estimatedInputTokens / 1_000_000) * model.inputCostPer1m +
    (req.estimatedOutputTokens / 1_000_000) * model.outputCostPer1m
  );
}

/** Maps a cost to 0..10 where free is 10. Log scale: $0.001 and $0.002 should not look far apart. */
function costScore(costUsd: number): number {
  if (costUsd <= 0) return 10;
  const normalized = Math.log10(costUsd * 1000 + 1); // $0.001 -> ~0.3, $1 -> ~3
  return Math.max(0, 10 - normalized * 3);
}

/** Every reason a model can be excluded. Order matters: report the most specific first. */
function ineligibleReason(model: RegisteredModel, req: RoutingRequest): string | null {
  if (!model.enabled) return "model is disabled";
  if (model.health === "unreachable") return "provider is unreachable";

  // --- Privacy is a hard constraint and is checked before anything else that
  // --- could be traded off. A local_only request must never reach the cloud
  // --- (spec §11, §67, §111), regardless of mode, cost, or availability.
  if ((req.privacy === "local_only" || req.mode === "local_only") && !model.local) {
    return "request is local-only and this model is not local";
  }
  if (req.privacy === "sensitive" && !model.local) {
    return "request is marked sensitive and this model is not local";
  }
  if (req.mode === "cloud_only" && model.local) {
    return "mode is cloud-only and this model is local";
  }

  for (const cap of req.requiredCapabilities) {
    if (!model.capabilities.includes(cap)) return `model does not support "${cap}"`;
  }

  const needed = req.estimatedInputTokens + Math.min(req.estimatedOutputTokens, model.maxOutputTokens) + CONTEXT_HEADROOM;
  if (needed > model.contextWindow) {
    return `context window too small (needs ~${needed}, has ${model.contextWindow})`;
  }

  if (req.maxCostUsd !== null && req.maxCostUsd !== undefined) {
    const cost = estimateCostUsd(model, req);
    if (cost > req.maxCostUsd) {
      return `estimated cost $${cost.toFixed(4)} exceeds the $${req.maxCostUsd.toFixed(4)} limit`;
    }
  }
  return null;
}

/** Short, user-facing explanations. Operational status only — never chain-of-thought (spec §81). */
function reasonsFor(model: RegisteredModel, req: RoutingRequest, cost: number): string[] {
  const out: string[] = [];
  if (model.local) out.push("runs locally, no data leaves this machine");
  if (cost === 0) out.push("free to run");
  else out.push(`~$${cost.toFixed(4)} estimated`);
  if (req.mode === "fastest") out.push(`speed score ${model.scores.speed}/10`);
  if (req.mode === "best") out.push(`reasoning score ${model.scores.reasoning}/10`);
  if ([...req.requiredCapabilities, ...req.preferredCapabilities].includes("coding")) {
    out.push(`coding score ${model.scores.coding}/10`);
  }
  if (model.health === "degraded") out.push("provider reported degraded health");
  return out;
}

export function route(models: RegisteredModel[], req: RoutingRequest): RoutingDecision {
  const rejected: Array<{ modelId: string; reason: string }> = [];
  const eligible: RegisteredModel[] = [];

  for (const m of models) {
    const reason = ineligibleReason(m, req);
    if (reason) rejected.push({ modelId: m.id, reason });
    else eligible.push(m);
  }

  // --- Explicit user override (spec §148): "use Claude" wins over scoring.
  // It cannot override the eligibility filter above, so an override that would
  // breach privacy is still refused — and the rejection says exactly why.
  if (req.requestedModelId) {
    const pinned = eligible.find((m) => m.id === req.requestedModelId);
    if (pinned) {
      const cost = estimateCostUsd(pinned, req);
      // The chosen model leads; the rest stay as fallbacks so a dead provider
      // does not turn an explicit preference into a hard failure.
      const rest = eligible.filter((m) => m.id !== pinned.id);
      const scoredRest = scoreAll(rest, req);
      return {
        mode: req.mode,
        candidates: [
          { model: pinned, score: Number.POSITIVE_INFINITY, estimatedCostUsd: cost, reasons: ["explicitly requested by you", ...reasonsFor(pinned, req, cost)] },
          ...scoredRest,
        ],
        rejected,
      };
    }
    // Requested but not eligible: fall through to normal routing and say so.
    const why = rejected.find((r) => r.modelId === req.requestedModelId);
    rejected.push({
      modelId: req.requestedModelId,
      reason: why ? `requested, but unavailable: ${why.reason}` : "requested, but not a known model",
    });
  }

  if (req.requestedProviderId) {
    const fromProvider = eligible.filter((m) => m.providerId === req.requestedProviderId);
    if (fromProvider.length > 0) {
      return { mode: req.mode, candidates: scoreAll(fromProvider, req), rejected };
    }
    rejected.push({ modelId: `provider:${req.requestedProviderId}`, reason: "requested provider has no eligible models" });
  }

  return { mode: req.mode, candidates: scoreAll(eligible, req), rejected };
}

function scoreAll(models: RegisteredModel[], req: RoutingRequest): RoutingCandidate[] {
  const w = weightsFor(req.mode);
  const candidates = models.map((model) => {
    const cost = estimateCostUsd(model, req);
    let score =
      qualityScore(model, [...req.requiredCapabilities, ...req.preferredCapabilities]) * w.quality +
      model.scores.speed * w.speed +
      costScore(cost) * w.cost;

    // Tie-breakers that reflect stated principles rather than raw numbers.
    if (model.local) score += 0.25;                 // local-first (spec §1.5)
    if (model.health === "degraded") score -= 1.5;  // prefer a healthy route
    if (model.health === "unknown") score -= 0.25;  // never health-checked yet

    return { model, score, estimatedCostUsd: cost, reasons: reasonsFor(model, req, cost) };
  });

  // Deterministic: equal scores resolve by id so routing is reproducible.
  candidates.sort((a, b) => (b.score - a.score) || a.model.id.localeCompare(b.model.id));
  return candidates;
}
