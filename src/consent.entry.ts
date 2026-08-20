/**
 * `@cross-deck/web/consent` — Crossdeck Consent (opt-in).
 *
 * The branded consent widget, the CMP coexistence adapters, and the guest
 * boot profile. Deliberately NOT part of the core bundle: most sites already
 * run their own CMP (which is exactly why the coexistence adapters exist), so
 * shipping this to everyone would tax every install for a feature most decline.
 *
 * Consent ENFORCEMENT is not here — it is core, always on, no opt-in:
 * `Crossdeck.consent({ analytics: false })` is the socket any external banner
 * plugs into, and GPC is honoured by default.
 *
 * Turn the widget on with the light switch instead of importing it yourself:
 *   Crossdeck.init({ appId, publicKey, environment, consentBanner: true })
 */
export {
  mountConsentBanner,
  CONSENT_INFO_URL,
  CONSENT_STORAGE_KEY,
} from "./consent-banner";
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
export { startConsentMode } from "./consent-mode";
export type {
  ConsentModeOptions,
  ConsentModeHandle,
  ConsentOwner,
} from "./consent-mode";
export {
  detectExistingConsent,
  subscribeToExternalConsent,
} from "./consent-coexistence";
export type {
  ExistingConsentSource,
  ConsentMechanism,
  VerificationStatus,
  DetectExistingConsentOptions,
  ConsentGlobals,
} from "./consent-coexistence";
