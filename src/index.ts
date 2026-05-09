/**
 * @cross-deck/web — public entry point.
 *
 * The default export is a singleton `Crossdeck` instance. Most apps want
 * exactly one client; instantiate `CrossdeckClient` directly if you need
 * isolated instances (e.g. one per tenant in a multi-tenant SaaS shell).
 */

export { Crossdeck, CrossdeckClient } from "./crossdeck";
export { CrossdeckError } from "./errors";
export { MemoryStorage } from "./storage";
export { SDK_NAME, SDK_VERSION, DEFAULT_BASE_URL } from "./http";

export type {
  CrossdeckOptions,
  IdentifyOptions,
  EventProperties,
  KeyValueStorage,
  PublicEntitlement,
  EntitlementsListResponse,
  AliasResult,
  PurchaseResult,
  HeartbeatResponse,
  Diagnostics,
  Environment,
  Platform,
  AuditRail,
  AutoTrackOptions,
} from "./types";
export type { DeviceInfo } from "./device-info";
export type { CrossdeckErrorType, CrossdeckErrorPayload } from "./errors";
