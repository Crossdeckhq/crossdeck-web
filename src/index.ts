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
export { CROSSDECK_ERROR_CODES, getErrorCode } from "./error-codes";

export type {
  CrossdeckOptions,
  IdentifyOptions,
  GroupTraits,
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
export type { ConsentState } from "./consent";
export type { DeviceInfo } from "./device-info";
export type { CrossdeckErrorType, CrossdeckErrorPayload } from "./errors";
export type { ErrorCodeEntry } from "./error-codes";
export type { Breadcrumb, BreadcrumbCategory, BreadcrumbLevel } from "./breadcrumbs";
export type { CapturedError, ErrorLevel } from "./error-capture";
export type { StackFrame } from "./stack-parser";
