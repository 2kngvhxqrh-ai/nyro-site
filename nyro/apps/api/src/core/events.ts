/**
 * Internal event bus (spec §72).
 *
 * In-process only, deliberately. A message broker would be infrastructure ahead
 * of a real requirement (§74, §116). The interface is narrow enough that moving
 * to one later is a swap of this file.
 */
export type NyroEvent =
  | { type: "model.requested"; modelId: string; providerId: string; conversationId: string | null }
  | { type: "model.completed"; modelId: string; latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "model.failed"; modelId: string; errorCode: string; latencyMs: number }
  | { type: "router.decided"; mode: string; chosenModelId: string | null; candidateCount: number; rejectedCount: number }
  | { type: "chat.started"; conversationId: string }
  | { type: "chat.completed"; conversationId: string; modelId: string }
  | { type: "chat.cancelled"; conversationId: string }
  | { type: "provider.health"; providerId: string; state: string };

export type EventHandler = (event: NyroEvent) => void;

export class EventBus {
  private handlers = new Set<EventHandler>();

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: NyroEvent): void {
    for (const h of this.handlers) {
      // A bad subscriber must never break the thing it is observing.
      try {
        h(event);
      } catch {
        /* ignore */
      }
    }
  }
}
