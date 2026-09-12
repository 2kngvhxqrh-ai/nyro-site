/**
 * The demo's link to the REAL system.
 *
 * These are not reimplementations. Vite bundles the actual modules from
 * apps/api/src, so the routing behaviour in the browser demo is the same code
 * that runs on the server — including the privacy constraints. If someone
 * changes the router, this page changes with it, and any divergence is a build
 * error rather than silent drift.
 */
export { route } from "../../../api/src/core/router.ts";
export { traitsFor } from "../../../api/src/providers/model-traits.ts";
export { PROVIDER_PRESETS } from "../../../api/src/providers/presets.ts";
export { estimateMessagesTokens, estimateTokens } from "../../../api/src/util/tokens.ts";
export { NyroError } from "../../../api/src/core/errors.ts";

export type {
  Capability,
  ChatMessage,
  PrivacyClass,
  RegisteredModel,
  RoutingDecision,
  RoutingMode,
  RoutingRequest,
} from "../../../api/src/core/types.ts";
