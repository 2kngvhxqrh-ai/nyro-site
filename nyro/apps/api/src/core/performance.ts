/**
 * Measured model performance (spec §13, §102).
 *
 * The registry's speed scores are guesses derived from a model's name. This
 * replaces them, for models NYRO has actually used, with something observed.
 *
 * It measures THROUGHPUT, not latency. Raw latency punishes a model for being
 * asked a harder question: a 900-token answer legitimately takes longer than a
 * 40-token one, and ranking on wall-clock would quietly bias routing toward
 * models that happened to get short prompts. Output tokens per second is the
 * property a user actually feels, and it is comparable across requests.
 *
 * Spec §147 warns against an opaque system the user cannot override, so:
 *  - a model needs a minimum number of samples before measurement is trusted
 *  - the decision reports when a score is measured and from how many runs
 *  - learning can be switched off entirely
 */

/** Below this, one slow cold start would swing a model's whole reputation. */
export const MIN_SAMPLES = 5;

export interface ObservedPerformance {
  modelId: string;
  /** Median output tokens per second across successful runs. */
  medianTokensPerSecond: number;
  /** Successful runs / attempted runs, excluding cancellations. */
  successRate: number;
  /** Successful runs measured. */
  samples: number;
}

/** 0..10, matching the registry's scale so the two are interchangeable. */
export function speedScoreFromThroughput(tokensPerSecond: number): number {
  if (tokensPerSecond <= 0) return 0;
  // ~3 tok/s scores ~1, ~30 scores ~5.5, ~300 scores 10. Log scale, because the
  // felt difference between 5 and 10 tok/s is much larger than 200 and 205.
  const score = (Math.log10(tokensPerSecond) / Math.log10(300)) * 10;
  return Math.max(0, Math.min(10, Number(score.toFixed(1))));
}

export interface PerformanceAdjustment {
  /** Replaces the registry's heuristic speed score. */
  speed: number;
  /** Score penalty for a model that fails often. 0 when reliable. */
  reliabilityPenalty: number;
  /** Short, user-facing note for the routing explanation. */
  note: string;
}

/**
 * Turns observations into a routing adjustment, or null when there is not
 * enough evidence to justify overriding the catalog.
 */
export function adjustmentFor(observed: ObservedPerformance | undefined): PerformanceAdjustment | null {
  if (!observed || observed.samples < MIN_SAMPLES) return null;

  const speed = speedScoreFromThroughput(observed.medianTokensPerSecond);

  // A model that fails a third of the time is worse than a slightly slower one
  // that works. Scaled so a perfect record costs nothing.
  const reliabilityPenalty = (1 - observed.successRate) * 6;

  const tps = observed.medianTokensPerSecond;
  const rounded = tps >= 10 ? Math.round(tps) : Number(tps.toFixed(1));
  const note =
    observed.successRate >= 0.99
      ? `measured ${rounded} tok/s over ${observed.samples} runs`
      : `measured ${rounded} tok/s, ${Math.round(observed.successRate * 100)}% success over ${observed.samples} runs`;

  return { speed, reliabilityPenalty, note };
}

/** Convenience for the router: a lookup keyed by model id. */
export type PerformanceIndex = Map<string, PerformanceAdjustment>;

export function buildPerformanceIndex(rows: ObservedPerformance[]): PerformanceIndex {
  const index: PerformanceIndex = new Map();
  for (const row of rows) {
    const adj = adjustmentFor(row);
    if (adj) index.set(row.modelId, adj);
  }
  return index;
}
