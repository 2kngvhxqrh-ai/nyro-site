/**
 * Data export (spec §108, §109).
 *
 * The public Nyro page states the constraint that shapes this project: "you
 * have to be able to read everything the system knows in a text editor, with
 * nothing running." Postgres is the opposite of that. Export is how the two
 * are reconciled — not a nice-to-have, but the thing that makes the stated
 * promise true.
 *
 * Two formats, because they serve different purposes:
 *  - JSON: complete and machine-readable, for backup and migration.
 *  - Markdown: your conversations as prose, readable in any text editor with
 *    nothing installed and nothing running.
 *
 * NEITHER contains an API key. The export is a file that will end up in cloud
 * storage, an email, or a git repo; putting decrypted credentials in it would
 * undo every protection in util/crypto.ts. Providers are exported by
 * configuration only, and the export says so in the file itself.
 */
import type { ConversationRepo, ModelRepo, ProviderRepo, RunRepo, SettingsRepo } from "../db/repos.ts";

export const EXPORT_FORMAT_VERSION = 1;

export interface ExportBundle {
  nyroExportVersion: number;
  exportedAt: string;
  /** Stated in the file so a reader never has to guess whether keys are in it. */
  note: string;
  providers: Array<Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
  conversations: Array<{
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages: Array<{ role: string; content: string; modelId: string | null; createdAt: string }>;
  }>;
  usage: { totalRuns: number; failedRuns: number; cancelledRuns: number; totalCostUsd: number };
}

const SETTINGS_KEYS = ["budget", "routing_rules", "measured_routing"] as const;

export async function buildExport(deps: {
  providers: ProviderRepo;
  models: ModelRepo;
  conversations: ConversationRepo;
  runs: RunRepo;
  settings: SettingsRepo;
}): Promise<ExportBundle> {
  // listPublic() is the key-free shape by construction, so this cannot leak one
  // even if someone adds a field to the provider row later.
  const providers = await deps.providers.listPublic();
  const models = await deps.models.list();
  const summaries = await deps.conversations.list(1000);
  const stats = await deps.runs.stats(24 * 365);

  const settings: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    const value = await deps.settings.get<unknown>(key);
    if (value !== null) settings[key] = value;
  }

  const conversations = [];
  for (const c of summaries) {
    const messages = await deps.conversations.messages(c.id, 10_000);
    conversations.push({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        modelId: m.modelId,
        createdAt: m.createdAt,
      })),
    });
  }

  return {
    nyroExportVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    note:
      "This export contains no API keys. Providers are listed by configuration only; " +
      "their credentials stay encrypted in the database and must be re-entered after a restore.",
    providers: providers.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      presetKey: p.presetKey,
      transport: p.transport,
      baseUrl: p.baseUrl,
      local: p.local,
      enabled: p.enabled,
      // Recorded so a restore knows a key is needed, without carrying one.
      requiresApiKey: p.hasApiKey,
    })),
    models: models.map((m) => ({
      id: m.id,
      providerId: m.providerId,
      modelIdentifier: m.modelIdentifier,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      inputCostPer1m: m.inputCostPer1m,
      outputCostPer1m: m.outputCostPer1m,
      capabilities: m.capabilities,
      scores: m.scores,
      local: m.local,
      enabled: m.enabled,
      traitsSource: m.traitsSource,
    })),
    settings,
    conversations,
    usage: {
      totalRuns: stats.totalRuns,
      failedRuns: stats.failedRuns,
      cancelledRuns: stats.cancelledRuns,
      totalCostUsd: stats.totalCostUsd,
    },
  };
}

/** Escapes nothing: conversation text is reproduced verbatim, which is the point. */
export function toMarkdown(bundle: ExportBundle): string {
  const out: string[] = [];
  out.push("# NYRO conversations");
  out.push("");
  out.push(`Exported ${bundle.exportedAt}`);
  out.push("");
  out.push(bundle.note);
  out.push("");
  out.push(`${bundle.conversations.length} conversation(s).`);
  out.push("");

  for (const c of bundle.conversations) {
    out.push("---");
    out.push("");
    out.push(`## ${c.title}`);
    out.push("");
    out.push(`*${c.messages.length} message(s) · last updated ${c.updatedAt}*`);
    out.push("");
    for (const m of c.messages) {
      const who = m.role === "user" ? "You" : m.modelId ? `NYRO (${m.modelId})` : "NYRO";
      out.push(`**${who}**`);
      out.push("");
      out.push(m.content);
      out.push("");
    }
  }

  if (bundle.conversations.length === 0) {
    out.push("*No conversations yet.*");
    out.push("");
  }
  return out.join("\n");
}
