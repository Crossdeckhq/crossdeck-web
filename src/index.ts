/**
 * @cross-deck/web — public entry point.
 *
 * The default export is a singleton `Crossdeck` instance. Most apps want
 * exactly one client; instantiate `CrossdeckClient` directly if you need
 * isolated instances (e.g. one per tenant in a multi-tenant SaaS shell).
 */

export { Crossdeck } from "./singleton";
export { CrossdeckClient } from "./crossdeck";
export { CrossdeckError } from "./errors";
// Crossdeck Trust — the human-proof panel. `Crossdeck.trust.panel(...)` is the
// usual entry; `mountTrustPanel` is the framework-agnostic core for non-SDK use.
export { mountTrustPanel, TRUST_PANEL_ORIGIN } from "./trust";
export type {
  TrustToken,
  TrustUnavailable,
  TrustResult,
  TrustTokenStatus,
  TrustPanelHandle,
  TrustPanelInput,
  MountTrustPanelOptions,
  CrossdeckTrustNamespace,
} from "./trust";
// Crossdeck Consent — OPT-IN (CD-185).
//
// Consent ENFORCEMENT is core and always shipped: the ConsentManager, the
// public `Crossdeck.consent()` socket that ANY external CMP plugs into, and
// GPC. That is the legal floor — a customer's own banner can always tell us
// "stop tracking", and nobody has to opt in to that.
//
// Consent PRESENTATION — the branded Crossdeck banner, the CMP auto-detect
// adapters, and the guest boot profile — is a FEATURE you switch on, never a
// tax on every install. Two ways to turn it on:
//
//   Crossdeck.init({ …, consentBanner: true })            ← the light switch
//   import { mountConsentBanner } from "@cross-deck/web/consent"
//
// The widget is code-split, so its bytes are fetched only when enabled. Types
// are erased at build time, so re-exporting them here costs zero bytes.
export type {
  ConsentBannerOptions,
  ConsentBannerHandle,
  ConsentBannerState,
  ConsentRecord,
  ConsentMethod,
  ConsentBannerMode,
  ConsentCategoryConfig,
  ConsentCategoriesConfig,
  CrossdeckConsentNamespace,
} from "./consent-banner";
export type {
  ConsentModeOptions,
  ConsentModeHandle,
  ConsentOwner,
} from "./consent-mode";
export type {
  ExistingConsentSource,
  ConsentMechanism,
  VerificationStatus,
  DetectExistingConsentOptions,
  ConsentGlobals,
} from "./consent-coexistence";
export { MemoryStorage } from "./storage";
export { SDK_NAME, SDK_VERSION, DEFAULT_BASE_URL } from "./http";
export { CROSSDECK_ERROR_CODES, getErrorCode } from "./error-codes";
export { CrossdeckContracts } from "./contracts";
export type {
  Contract,
  ContractPillar,
  ContractStatus,
  ContractAppliesTo,
  ContractTestRef,
  ContractFailureInput,
} from "./contracts";

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
