/**
 * Crossdeck Consent Mode — the single on-switch for the marketplace / guest build
 * (Path B, CD-175/CD-185). A connector calls `startConsentMode(...)` INSTEAD of
 * `Crossdeck.start(...)`; this boots Crossdeck in the guest posture and wires the
 * branded consent widget + co-existence deferral together.
 *
 * The guest posture (why each is here — the Webflow findings):
 *   - `cookieDomain: "none"`   → identity is host-scoped, no broad-domain probing (#8)
 *   - `autoTrack.errors: false`→ no error capture ⇒ no fetch/XHR/history wrapping (#7)
 *   - `autoTrack.wrapHistory: false` → never monkey-patch history for SPA nav (#7)
 *   - `autoTrack.clicks: false` / `webVitals: false` → minimal capture (#5)
 *   - `autoTrack.stripUrlParams: true` → no query/fragment/referrer in analytics (#3)
 *   - consent DENIED + identityOptIn FALSE at boot → nothing sends until the visitor
 *     opts in via the widget (#4, #9); identity is explicit-opt-in only (#2)
 *   - the Trust iframe is simply never mounted (#6)
 *
 * The full-capability path (Path A / direct install) is unaffected — this is a
 * separate boot profile, not a change to the core SDK's defaults.
 */
import { Crossdeck as defaultClient } from "./singleton";
import type { CrossdeckClient } from "./crossdeck";
import type { ConsentState } from "./consent";
import type { Environment } from "./types";
import {
  mountConsentBanner,
  type ConsentBannerHandle,
  type ConsentBannerState,
} from "./consent-banner";
import {
  detectExistingConsent,
  subscribeToExternalConsent,
} from "./consent-coexistence";

/** Who owns the consent moment on this site. */
export type ConsentOwner = "auto" | "crossdeck" | "external";

export interface ConsentModeOptions {
  /** Client-safe publishable key (`cd_pub_…`). Ingest-only — never a secret key. */
  publicKey: string;
  /** The Crossdeck app id the connector provisioned. */
  appId: string;
  /** Environment. Defaults to "production" (marketplace installs are live). */
  environment?: Environment;
  /**
   * The SITE OWNER's privacy-policy URL. REQUIRED — the Crossdeck-managed banner
   * will not render without it (it is the site owner's tool, reflecting their
   * policy). Ignored when we defer to an existing CMP.
   */
  policyUrl: string;
  /** Where the banner mounts (element or selector). Defaults to document.body. */
  target?: HTMLElement | string;
  /** Identity cookie scope. Defaults to "none" (host-only) for the guest build. */
  cookieDomain?: string;
  /**
   * Who manages consent. "auto" (default) → render the Crossdeck banner only if
   * no other CMP is detected. "crossdeck" → always render ours. "external" →
   * always defer, never render ours.
   */
  consentOwner?: ConsentOwner;
  /** Called whenever the visitor's choice changes. */
  onChange?: (state: ConsentBannerState) => void;
  /** The Crossdeck client to drive. Defaults to the singleton. */
  client?: CrossdeckClient;
}

export interface ConsentModeHandle {
  /** The mounted banner, or null when we deferred to an existing CMP. */
  banner: ConsentBannerHandle | null;
  /** The consent mechanism we deferred to (its label), or null if we own it. */
  deferredTo: string | null;
}

/**
 * Boot Crossdeck in consent-mode and wire the widget + co-existence. One call.
 */
export function startConsentMode(opts: ConsentModeOptions): ConsentModeHandle {
  const client = opts.client ?? defaultClient;

  // 1. Boot in the guest posture (see file header for the finding each maps to).
  client.start({
    publicKey: opts.publicKey,
    appId: opts.appId,
    environment: opts.environment ?? "production",
    cookieDomain: opts.cookieDomain ?? "none",
    respectDnt: true,
    scrubPii: true,
    autoTrack: {
      clicks: false,
      webVitals: false,
      errors: false,
      stripUrlParams: true,
      wrapHistory: false,
    },
  });

  // 2. Deny everything at boot — nothing leaves the SDK until the visitor grants.
  client.consent({ analytics: false, marketing: false, errors: false });
  client.setIdentityOptIn(false);

  // The widget routes analytics/marketing through the public consent() method;
  // onChange carries the identity opt-in (no ConsentManager dimension, by design).
  const consentAdapter = {
    set: (partial: Partial<ConsentState>): ConsentState => client.consent(partial),
  };
  const onWidgetChange = (state: ConsentBannerState): void => {
    client.setIdentityOptIn(state.identityOptIn);
    opts.onChange?.(state);
  };

  // 3. Co-existence — never a second banner. GPC + any detected CMP wins.
  const owner: ConsentOwner = opts.consentOwner ?? "auto";
  if (owner !== "crossdeck") {
    const existing = detectExistingConsent();
    if (existing) {
      const read = existing.read();
      client.consent({
        analytics: read.analytics ?? false,
        marketing: read.marketing ?? false,
      });
      if (existing.emitsChanges) {
        subscribeToExternalConsent(existing, (partial) => {
          client.consent(partial);
        });
      }
      return { banner: null, deferredTo: existing.source };
    }
    if (owner === "external") {
      // Owner runs their own tool but none was detected yet — stay denied,
      // render nothing. (They wire their tool → client.consent themselves.)
      return { banner: null, deferredTo: null };
    }
  }

  // 4. We own the consent moment — render the Crossdeck banner (managed mode).
  const banner = mountConsentBanner({
    target: opts.target,
    policyUrl: opts.policyUrl,
    consent: consentAdapter,
    onChange: onWidgetChange,
  });
  return { banner, deferredTo: null };
}
