/**
 * Consent co-existence — "defer, never double up" (CD-185, PART 1).
 *
 * Crossdeck Consent is a branded banner bundled into the injected SDK. It must
 * NEVER render a second consent banner on a site that already manages consent —
 * two banners is a poor-experience marketplace auto-reject. On init we detect any
 * existing consent mechanism; if one is present we do NOT render our banner and
 * instead READ its signal and gate autocapture off it.
 *
 * Detection order (first match wins → defer & read):
 *   1. Explicit site-owner config  — "I use my own CMP" → read the configured source.
 *   2. GPC  — navigator.globalPrivacyControl; a legally-binding opt-out in several
 *             US states → ALWAYS honour (force marketing + analytics OFF).
 *   3. IAB TCF v2.2  — window.__tcfapi → subscribe, map purpose consents.
 *   4. IAB GPP  — window.__gpp (supersedes US Privacy __uspapi) → read US signals.
 *   5. Google Consent Mode v2  — analytics_storage / ad_storage / ad_user_data in
 *             the dataLayer → read.
 *   6. Known CMP plugins  — Cookiebot, OneTrust, CookieYes, Osano, Termly.
 *   7. Platform-native  — Webflow / Wix / Squarespace cookie banners.
 *
 * DESIGN CONTRACT (mirrors trust.ts):
 *  - ISOLATED — every global / DOM / postMessage touch is wrapped in `safe()`; a
 *    stumble in a detector can never throw into the host page or the rest of the SDK.
 *  - CONSERVATIVE — external purposes map to our {analytics, marketing} categories
 *    "when in doubt, deny." A detected-but-unreadable CMP defers (no banner) AND
 *    keeps capture OFF until we can positively read a grant.
 *  - SUBSCRIBE, DON'T SNAPSHOT — where the source emits changes (TCF / GPP /
 *    Consent Mode / Cookiebot / OneTrust) we subscribe and update capture live when
 *    the visitor changes their choice in the OTHER tool. Snapshot-only sources
 *    return a no-op unsubscribe.
 *
 * API-VERIFICATION LEDGER ("pack your bags" — confirmed against current docs):
 *  - GPC              CONFIRMED  — https://globalprivacycontrol.github.io/gpc-spec/
 *  - TCF v2.2         CONFIRMED  — IAB Tech Lab CMP API v2 (__tcfapi signature,
 *                                  addEventListener/removeEventListener, eventStatus,
 *                                  purpose.consents):
 *                                  https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20CMP%20API%20v2.md
 *                                  Purpose IDs 1-10: https://support.didomi.io/iab-tcf-v2.2-purposes/features-summary
 *  - Cookiebot        CONFIRMED  — Cookiebot.consent.{statistics,marketing} +
 *                                  CookiebotOnConsentReady/OnAccept/OnDecline events:
 *                                  https://www.cookiebot.com/en/developer/
 *  - OneTrust         CONFIRMED  — window.OnetrustActiveGroups (',C0002,'/',C0004,')
 *                                  + OneTrust.OnConsentChanged:
 *                                  https://developer.onetrust.com/onetrust/docs/javascript-api
 *  - IAB GPP          NEEDS-FINAL-VERIFICATION — __gpp(command,cb,parameter) signature +
 *                                  ping/addEventListener/getSection confirmed
 *                                  (https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform/blob/main/Core/CMP%20API%20Specification.md),
 *                                  but the per-section US-state FIELD layouts (uspv1 /
 *                                  usnat / usca) vary — confirm field names before GA.
 *  - Google Consent Mode  NEEDS-FINAL-VERIFICATION — gtag('consent','default'|'update',{...})
 *                                  and the storage keys are confirmed
 *                                  (https://developers.google.com/tag-platform/security/guides/consent),
 *                                  BUT Google publishes NO official read/subscribe API
 *                                  for current consent state. We scan `dataLayer` and
 *                                  chain `dataLayer.push` (non-destructive, reversible).
 *                                  Re-confirm against the gtag reference before GA.
 *  - Osano / CookieYes / Termly  NEEDS-FINAL-VERIFICATION — presence-detected only; we do
 *                                  NOT fabricate a read API, so a detected instance defers
 *                                  and stays conservative-deny until a verified reader lands.
 *  - Webflow / Wix / Squarespace native  NEEDS-FINAL-VERIFICATION — presence-detected only,
 *                                  same conservative-deny handling as above.
 */

import type { ConsentState } from "./consent";

// ============================================================
// Public types
// ============================================================

/** The consent mechanisms we can detect and defer to. */
export type ConsentMechanism =
  | "site-config"
  | "gpc"
  | "tcf-v2"
  | "gpp"
  | "google-consent-mode"
  | "cookiebot"
  | "onetrust"
  | "cookieyes"
  | "osano"
  | "termly"
  | "webflow-native"
  | "wix-native"
  | "squarespace-native";

/** How confident we are in the read/subscribe wiring for a mechanism. */
export type VerificationStatus = "confirmed" | "needs-verification";

/**
 * A detected existing consent mechanism. If `detectExistingConsent` returns one of
 * these, Crossdeck Consent MUST NOT render its own banner — read `read()` for the
 * current mapped grant and (if `emitsChanges`) call `subscribeToExternalConsent` to
 * follow live changes.
 */
export interface ExistingConsentSource {
  /** Which mechanism was detected. */
  readonly mechanism: ConsentMechanism;
  /** Human-readable label for logs / the "deferring to X" disclosure. */
  readonly source: string;
  /**
   * Snapshot read of the source, mapped conservatively to our categories. Only the
   * keys the source speaks to are present; absent keys leave our defaults untouched.
   * GPC returns { analytics:false, marketing:false }.
   */
  read(): Partial<ConsentState>;
  /** True iff `subscribeToExternalConsent` can deliver live updates for this source. */
  readonly emitsChanges: boolean;
  /**
   * Categories this source FORCES off regardless of anything else (GPC → analytics +
   * marketing). Enforced on top of `read()` — a legally-binding opt-out cannot be
   * flipped back on by any later signal.
   */
  readonly forcesDeny?: ReadonlyArray<keyof ConsentState>;
  /** API-confirmation status for this mechanism (see the file-top ledger). */
  readonly verification: VerificationStatus;
}

/** Options for {@link detectExistingConsent}. */
export interface DetectExistingConsentOptions {
  /**
   * The site owner explicitly declared (at install) that they run their own consent
   * tool ("I use my own CMP"). Highest priority — we defer unconditionally.
   */
  ownConsentTool?: boolean;
  /**
   * Optional reader for the owner's configured source, used only when `ownConsentTool`
   * is set. Returns their current grant mapped to our categories. If omitted we defer
   * (render nothing) and stay conservative-deny until the owner wires a reader.
   */
  readOwnConsent?: () => Partial<ConsentState>;
  /**
   * Global scope to probe. Defaults to the real window. Injectable for tests and for
   * SSR guards (pass a plain object to probe nothing).
   */
  scope?: ConsentGlobals;
}

// ============================================================
// Typed views over the third-party globals we probe
// ============================================================

/** IAB TCF v2.2 CMP API. Signature: __tcfapi(command, version, callback, parameter?). */
type TcfApi = (
  command: string,
  version: number,
  callback: (data: unknown, success: boolean) => void,
  parameter?: unknown,
) => void;

/** The subset of the TCF `TCData` object we read. */
interface TcData {
  eventStatus?: string;
  gdprApplies?: boolean;
  listenerId?: number;
  purpose?: { consents?: Record<string, boolean> };
}

/** IAB GPP CMP API. Signature: __gpp(command, callback, parameter?, version?). */
type GppApi = (
  command: string,
  callback: (data: unknown, success: boolean) => void,
  parameter?: unknown,
  version?: number,
) => void;

/** Cookiebot's window.Cookiebot object (the fields we read). */
interface CookiebotGlobal {
  consent?: {
    necessary?: boolean;
    preferences?: boolean;
    statistics?: boolean;
    marketing?: boolean;
  };
  consented?: boolean;
}

/** OneTrust's window.OneTrust object (the change hook we use). */
interface OneTrustGlobal {
  OnConsentChanged?: (callback: (event: unknown) => void) => void;
}

/** A dataLayer that is a real array with a reassignable push (Google Consent Mode). */
type DataLayerArray = unknown[] & {
  push: (...items: unknown[]) => number;
};

/**
 * The globals we probe. Everything is optional — presence is the detection signal.
 * Kept as one interface so `scope` is fully typed with no `any`.
 */
export interface ConsentGlobals {
  navigator?: Navigator & { globalPrivacyControl?: boolean };
  __tcfapi?: TcfApi;
  __gpp?: GppApi;
  dataLayer?: unknown[];
  Cookiebot?: CookiebotGlobal;
  OneTrust?: OneTrustGlobal;
  OnetrustActiveGroups?: string;
  OptanonActiveGroups?: string;
  Osano?: unknown;
  CookieYes?: unknown;
  cookieyes?: unknown;
  getCkyConsent?: unknown;
  Termly?: unknown;
  Webflow?: unknown;
  consentPolicyManager?: unknown; // Wix
  Static?: unknown; // Squarespace exposes window.Static
  addEventListener?: Window["addEventListener"];
  removeEventListener?: Window["removeEventListener"];
}

// ============================================================
// Detection — first match wins
// ============================================================

/**
 * Detect the first existing consent mechanism on the page, in the CD-185 priority
 * order. Returns the source to defer to, or `null` if nothing is present (in which
 * case Crossdeck Consent may render its own banner, subject to Part 3's "who owns
 * consent" choice).
 *
 * Guaranteed not to throw — any probe failure is swallowed and treated as "absent".
 */
export function detectExistingConsent(
  opts?: DetectExistingConsentOptions,
): ExistingConsentSource | null {
  const scope = resolveScope(opts?.scope);
  if (!scope) return null;

  // 1. Explicit site-owner config — highest priority.
  if (opts?.ownConsentTool) {
    const reader = opts.readOwnConsent;
    return {
      mechanism: "site-config",
      source: "Site owner's own consent tool",
      emitsChanges: false,
      verification: "confirmed",
      read: () =>
        // Their reader wins; without one we defer AND stay conservative-deny so we
        // never capture on a site whose consent we cannot read.
        safeRead(() => reader?.(), undefined) ??
        ({ analytics: false, marketing: false } as Partial<ConsentState>),
    };
  }

  // 2. GPC — legally binding, always honoured. Checked before every CMP so it can
  //    never be overridden by a downstream signal.
  //    Spec: https://globalprivacycontrol.github.io/gpc-spec/
  if (safeRead(() => scope.navigator?.globalPrivacyControl === true, false)) {
    return {
      mechanism: "gpc",
      source: "Global Privacy Control (navigator.globalPrivacyControl)",
      emitsChanges: false, // GPC is a static per-request signal; no change event.
      forcesDeny: ["analytics", "marketing"],
      verification: "confirmed",
      read: () => ({ analytics: false, marketing: false }),
    };
  }

  // 3. IAB TCF v2.2.
  if (typeof scope.__tcfapi === "function") {
    return {
      mechanism: "tcf-v2",
      source: "IAB TCF v2.2 (__tcfapi)",
      emitsChanges: true,
      verification: "confirmed",
      read: () => readTcfSnapshot(scope),
    };
  }

  // 4. IAB GPP (supersedes the deprecated US Privacy __uspapi).
  if (typeof scope.__gpp === "function") {
    return {
      mechanism: "gpp",
      source: "IAB GPP (__gpp)",
      emitsChanges: true,
      verification: "needs-verification",
      read: () => readGppSnapshot(scope),
    };
  }

  // 5. Google Consent Mode v2 — only if the dataLayer actually carries consent
  //    signals (a bare GTM dataLayer is NOT a consent mechanism).
  if (hasConsentModeSignal(scope.dataLayer)) {
    return {
      mechanism: "google-consent-mode",
      source: "Google Consent Mode v2 (dataLayer)",
      emitsChanges: true,
      verification: "needs-verification",
      read: () => readConsentMode(scope.dataLayer),
    };
  }

  // 6. Known CMP plugins.
  if (isObject(scope.Cookiebot)) {
    return {
      mechanism: "cookiebot",
      source: "Cookiebot",
      emitsChanges: true,
      verification: "confirmed",
      read: () => readCookiebot(scope),
    };
  }
  if (
    isObject(scope.OneTrust) ||
    typeof scope.OnetrustActiveGroups === "string" ||
    typeof scope.OptanonActiveGroups === "string"
  ) {
    return {
      mechanism: "onetrust",
      source: "OneTrust",
      emitsChanges: true,
      verification: "confirmed",
      read: () => readOneTrust(scope),
    };
  }
  // CookieYes / Osano / Termly — presence-detected only. We do NOT invent a read API,
  // so we defer (no banner) and stay conservative-deny until a verified reader ships.
  if (scope.CookieYes != null || scope.cookieyes != null || scope.getCkyConsent != null) {
    return deferUnread("cookieyes", "CookieYes");
  }
  if (scope.Osano != null) {
    return deferUnread("osano", "Osano");
  }
  if (scope.Termly != null) {
    return deferUnread("termly", "Termly");
  }

  // 7. Platform-native banners — presence-detected only, same conservative handling.
  //    (Best-effort heuristics; confirm exact globals per platform before GA.)
  if (isWebflowCookieConsent(scope)) {
    return deferUnread("webflow-native", "Webflow cookie consent");
  }
  if (scope.consentPolicyManager != null) {
    return deferUnread("wix-native", "Wix cookie banner");
  }
  if (isSquarespaceCookieBanner(scope)) {
    return deferUnread("squarespace-native", "Squarespace cookie banner");
  }

  return null;
}

/**
 * A detected-but-unreadable source: we defer (never double up) and keep every
 * non-essential category OFF until a verified reader for it exists. Conservative by
 * construction — "when in doubt, deny."
 */
function deferUnread(
  mechanism: ConsentMechanism,
  label: string,
): ExistingConsentSource {
  return {
    mechanism,
    source: label + " (detected; read not yet verified)",
    emitsChanges: false,
    verification: "needs-verification",
    read: () => ({ analytics: false, marketing: false }),
  };
}

// ============================================================
// Subscription — follow live changes in the other tool
// ============================================================

/**
 * Subscribe to a source that emits changes and forward each new mapped grant to `cb`.
 * Returns an unsubscribe function. Snapshot-only sources (GPC, site-config, and any
 * presence-only `deferUnread` source) return a no-op unsubscribe.
 *
 * Guaranteed not to throw — wiring failures degrade to a no-op unsubscribe.
 */
export function subscribeToExternalConsent(
  source: ExistingConsentSource,
  cb: (state: Partial<ConsentState>) => void,
  opts?: { scope?: ConsentGlobals },
): () => void {
  const scope = resolveScope(opts?.scope);
  if (!scope || !source.emitsChanges) return noop;

  switch (source.mechanism) {
    case "tcf-v2":
      return subscribeTcf(scope, cb);
    case "gpp":
      return subscribeGpp(scope, cb);
    case "google-consent-mode":
      return subscribeConsentMode(scope, cb);
    case "cookiebot":
      return subscribeCookiebot(scope, cb);
    case "onetrust":
      return subscribeOneTrust(scope, cb);
    default:
      return noop;
  }
}

// ------------------------------------------------------------
// TCF v2.2
// ------------------------------------------------------------

/**
 * Purpose → category mapping (conservative, "when in doubt deny").
 *   analytics ← Purpose 1 (store/access info on device) AND Purpose 8 (measure
 *               content performance) — the two purposes first-party product analytics
 *               depends on. Purposes 9/10 (cross-source audience building / product
 *               improvement) are broader and NOT required to grant analytics.
 *   marketing ← Purpose 1 AND Purpose 3 (create a personalised-ads profile) AND
 *               Purpose 4 (select personalised ads) — the core advertising consents.
 * Any required purpose missing → that category is denied.
 * IDs per https://support.didomi.io/iab-tcf-v2.2-purposes/features-summary
 */
function mapTcfPurposes(d: TcData): Partial<ConsentState> {
  // gdprApplies === false: GDPR does not apply to this user, so TCF imposes no
  // restriction — do not manufacture a denial.
  if (d.gdprApplies === false) return { analytics: true, marketing: true };
  const c = d.purpose?.consents ?? {};
  const has = (id: number): boolean => c[String(id)] === true;
  return {
    analytics: has(1) && has(8),
    marketing: has(1) && has(3) && has(4),
  };
}

function readTcfSnapshot(scope: ConsentGlobals): Partial<ConsentState> {
  const api = scope.__tcfapi;
  if (typeof api !== "function") return {};
  let out: Partial<ConsentState> = {};
  // getTCData resolves synchronously when the CMP is loaded; if it hasn't, the
  // callback simply doesn't fire and we keep {} (defaults untouched) until the
  // subscription delivers the first `tcloaded`.
  safe(() =>
    api("getTCData", 2, (data: unknown, success: boolean) => {
      if (success && isObject(data)) out = mapTcfPurposes(data as TcData);
    }),
  );
  return out;
}

function subscribeTcf(
  scope: ConsentGlobals,
  cb: (state: Partial<ConsentState>) => void,
): () => void {
  const api = scope.__tcfapi;
  if (typeof api !== "function") return noop;
  let listenerId: number | null = null;

  const handler = (data: unknown, success: boolean): void => {
    if (!success || !isObject(data)) return;
    const d = data as TcData;
    if (typeof d.listenerId === "number") listenerId = d.listenerId;
    // Map only on states that carry a settled consent snapshot.
    if (d.eventStatus === "tcloaded" || d.eventStatus === "useractioncomplete") {
      safe(() => cb(mapTcfPurposes(d)));
    }
  };

  safe(() => api("addEventListener", 2, handler));

  return () => {
    if (listenerId == null) return;
    const id = listenerId;
    safe(() =>
      api(
        "removeEventListener",
        2,
        () => {
          /* removal ack — nothing to do */
        },
        id,
      ),
    );
  };
}

// ------------------------------------------------------------
// IAB GPP  (NEEDS-FINAL-VERIFICATION: per-section US-state field layouts)
// ------------------------------------------------------------

/** The subset of GPP `PingReturn` we read. */
interface GppPing {
  signalStatus?: string;
  applicableSections?: unknown;
  parsedSections?: Record<string, unknown>;
}

/** GPP addEventListener event object. */
interface GppEvent {
  eventName?: string;
  data?: unknown;
  pingData?: GppPing;
}

/**
 * Map GPP US-state signals conservatively. We read the (legacy but widely present)
 * US Privacy section `uspv1`, whose string's 3rd char = "opt-out of sale": 'Y' → the
 * user opted out → deny marketing. Analytics is not gated by US Privacy, so we leave
 * it untouched (no key emitted). The newer usnat/usca sections carry richer opt-outs
 * (targeted advertising, sale, sharing) but their FIELD names vary by version — hence
 * this mechanism is flagged needs-verification; wire those fields once confirmed.
 */
function mapGppPing(ping: GppPing): Partial<ConsentState> {
  const parsed = ping.parsedSections;
  if (!isObject(parsed)) return {};
  const usp = (parsed as Record<string, unknown>)["uspv1"];
  const uspString = extractUspString(usp);
  if (uspString && uspString.length >= 3) {
    // char[2]: 'Y' opted out of sale, 'N' did not, '-' not applicable.
    if (uspString.charAt(2) === "Y") return { marketing: false };
    if (uspString.charAt(2) === "N") return { marketing: true };
  }
  return {};
}

/** uspv1 may be parsed to a string or an object carrying the raw string. */
function extractUspString(usp: unknown): string | null {
  if (typeof usp === "string") return usp;
  if (isObject(usp)) {
    const rec = usp as Record<string, unknown>;
    for (const key of ["Value", "value", "uspString", "String"]) {
      if (typeof rec[key] === "string") return rec[key] as string;
    }
  }
  return null;
}

function readGppSnapshot(scope: ConsentGlobals): Partial<ConsentState> {
  const api = scope.__gpp;
  if (typeof api !== "function") return {};
  let out: Partial<ConsentState> = {};
  safe(() =>
    api("ping", (data: unknown, success: boolean) => {
      if (success && isObject(data)) out = mapGppPing(data as GppPing);
    }),
  );
  return out;
}

function subscribeGpp(
  scope: ConsentGlobals,
  cb: (state: Partial<ConsentState>) => void,
): () => void {
  const api = scope.__gpp;
  if (typeof api !== "function") return noop;
  let listenerId: number | null = null;

  const handler = (evt: unknown, success: boolean): void => {
    if (!success || !isObject(evt)) return;
    const e = evt as GppEvent & { listenerId?: number };
    if (typeof e.listenerId === "number") listenerId = e.listenerId;
    const ping = e.pingData;
    if (isObject(ping) && (ping as GppPing).signalStatus === "ready") {
      safe(() => cb(mapGppPing(ping as GppPing)));
    }
  };

  safe(() => api("addEventListener", handler));

  return () => {
    if (listenerId == null) return;
    const id = listenerId;
    safe(() =>
      api(
        "removeEventListener",
        () => {
          /* removal ack */
        },
        id,
      ),
    );
  };
}

// ------------------------------------------------------------
// Google Consent Mode v2  (NEEDS-FINAL-VERIFICATION: no official read/subscribe API)
// ------------------------------------------------------------

/** True iff the dataLayer carries at least one gtag('consent', …) entry. */
function hasConsentModeSignal(dataLayer: unknown): boolean {
  if (!Array.isArray(dataLayer)) return false;
  for (const entry of dataLayer) {
    const e = asIndexed(entry);
    if (e && e[0] === "consent") return true;
  }
  return false;
}

/**
 * Fold every consent 'default'/'update' entry in dataLayer, last-write-wins, into our
 * categories. gtag pushes an arguments-like object `{0:'consent',1:'update',2:{…}}`;
 * we also accept plain arrays. Values are 'granted' | 'denied'; anything else → denied.
 *   analytics ← analytics_storage === 'granted'
 *   marketing ← ad_storage === 'granted'  (require the ad-cookie grant; ad_user_data /
 *               ad_personalization only narrow it further, never widen it)
 */
function readConsentMode(dataLayer: unknown): Partial<ConsentState> {
  if (!Array.isArray(dataLayer)) return {};
  let analyticsStorage: string | undefined;
  let adStorage: string | undefined;
  for (const entry of dataLayer) {
    const e = asIndexed(entry);
    if (!e || e[0] !== "consent") continue;
    const mode = e[1];
    if (mode !== "default" && mode !== "update") continue;
    const vals = e[2];
    if (!isObject(vals)) continue;
    const v = vals as Record<string, unknown>;
    if (typeof v.analytics_storage === "string") analyticsStorage = v.analytics_storage;
    if (typeof v.ad_storage === "string") adStorage = v.ad_storage;
  }
  const out: Partial<ConsentState> = {};
  if (analyticsStorage !== undefined) out.analytics = analyticsStorage === "granted";
  if (adStorage !== undefined) out.marketing = adStorage === "granted";
  return out;
}

/**
 * Subscribe by CHAINING dataLayer.push. Google exposes no consent read/subscribe API,
 * so this is the pragmatic industry approach: wrap `push` to observe new consent
 * entries, always calling the original first (non-destructive), and restore the
 * original on unsubscribe (fully reversible). This wraps ONLY the customer's own
 * dataLayer array — it is not host-global fetch/XHR/history monkey-patching.
 * NEEDS-FINAL-VERIFICATION against the current gtag reference before GA.
 */
function subscribeConsentMode(
  scope: ConsentGlobals,
  cb: (state: Partial<ConsentState>) => void,
): () => void {
  const dl = scope.dataLayer;
  if (!Array.isArray(dl)) return noop;
  const arr = dl as DataLayerArray;
  const original = arr.push;
  if (typeof original !== "function") return noop;
  const originalBound = original.bind(arr) as DataLayerArray["push"];
  let active = true;

  const wrapped: DataLayerArray["push"] = (...items: unknown[]): number => {
    const result = originalBound(...items);
    if (active) {
      for (const item of items) {
        const e = asIndexed(item);
        if (e && e[0] === "consent" && (e[1] === "default" || e[1] === "update")) {
          safe(() => cb(readConsentMode(arr)));
          break;
        }
      }
    }
    return result;
  };

  const installed = safeRead(() => {
    arr.push = wrapped;
    return true;
  }, false);
  if (!installed) return noop;

  return () => {
    active = false;
    // Only restore if nothing else re-wrapped push after us.
    safe(() => {
      if (arr.push === wrapped) arr.push = original;
    });
  };
}

// ------------------------------------------------------------
// Cookiebot  (CONFIRMED)
// ------------------------------------------------------------

/** Cookiebot.consent.statistics → analytics; .marketing → marketing. */
function readCookiebot(scope: ConsentGlobals): Partial<ConsentState> {
  const c = scope.Cookiebot?.consent;
  if (!isObject(c)) return {};
  const out: Partial<ConsentState> = {};
  if (typeof c.statistics === "boolean") out.analytics = c.statistics;
  if (typeof c.marketing === "boolean") out.marketing = c.marketing;
  return out;
}

/** Confirmed events: CookiebotOnConsentReady / CookiebotOnAccept / CookiebotOnDecline. */
const COOKIEBOT_EVENTS = [
  "CookiebotOnConsentReady",
  "CookiebotOnAccept",
  "CookiebotOnDecline",
] as const;

function subscribeCookiebot(
  scope: ConsentGlobals,
  cb: (state: Partial<ConsentState>) => void,
): () => void {
  const add = scope.addEventListener;
  const remove = scope.removeEventListener;
  if (typeof add !== "function") return noop;
  const handler = (): void => safe(() => cb(readCookiebot(scope)));
  for (const name of COOKIEBOT_EVENTS) {
    safe(() => add.call(scope, name, handler as EventListener, false));
  }
  return () => {
    if (typeof remove !== "function") return;
    for (const name of COOKIEBOT_EVENTS) {
      safe(() => remove.call(scope, name, handler as EventListener, false));
    }
  };
}

// ------------------------------------------------------------
// OneTrust  (CONFIRMED)
// ------------------------------------------------------------

/**
 * OneTrust exposes active category IDs as a comma-wrapped string in
 * window.OnetrustActiveGroups, e.g. ',C0001,C0002,C0004,'. Default taxonomy:
 *   C0001 strictly necessary · C0002 performance/analytics · C0003 functional ·
 *   C0004 targeting/advertising · C0005 social media.
 *   analytics ← contains ',C0002,'   marketing ← contains ',C0004,'
 */
function readOneTrust(scope: ConsentGlobals): Partial<ConsentState> {
  const groups =
    (typeof scope.OnetrustActiveGroups === "string" && scope.OnetrustActiveGroups) ||
    (typeof scope.OptanonActiveGroups === "string" && scope.OptanonActiveGroups) ||
    "";
  if (!groups) return {};
  return {
    analytics: groups.includes(",C0002,"),
    marketing: groups.includes(",C0004,"),
  };
}

function subscribeOneTrust(
  scope: ConsentGlobals,
  cb: (state: Partial<ConsentState>) => void,
): () => void {
  const ot = scope.OneTrust;
  if (!isObject(ot) || typeof ot.OnConsentChanged !== "function") return noop;
  // Guarded by the typeof check above; cast to the checked call signature.
  const onConsentChanged = ot.OnConsentChanged as (cb: () => void) => void;
  // OnConsentChanged re-reads the (freshly updated) global string; the event detail
  // format varies across OneTrust versions, so we always re-read OnetrustActiveGroups
  // rather than trusting the event payload.
  safe(() => onConsentChanged(() => safe(() => cb(readOneTrust(scope)))));
  // OneTrust's OnConsentChanged provides no documented de-registration handle; the
  // callback simply forwards reads. There is nothing to tear down.
  return noop;
}

// ------------------------------------------------------------
// Platform-native best-effort presence heuristics
// ------------------------------------------------------------

/** Webflow sites expose window.Webflow; a cookie-consent module lives under it. */
function isWebflowCookieConsent(scope: ConsentGlobals): boolean {
  if (!isObject(scope.Webflow)) return false;
  // Presence of the cc/cookie-consent require entry is the signal; exact API varies,
  // so we only detect (then defer conservative-deny). Confirm the read before GA.
  return safeRead(() => {
    const wf = scope.Webflow as { require?: (name: string) => unknown };
    return typeof wf.require === "function";
  }, false);
}

/** Squarespace exposes window.Static.SQUARESPACE_CONTEXT; the cookie banner is site-config driven. */
function isSquarespaceCookieBanner(scope: ConsentGlobals): boolean {
  if (!isObject(scope.Static)) return false;
  return safeRead(() => {
    const s = scope.Static as { SQUARESPACE_CONTEXT?: unknown };
    return s.SQUARESPACE_CONTEXT != null;
  }, false);
}

// ============================================================
// Shared helpers
// ============================================================

const noop = (): void => {
  /* snapshot-only source, or nothing to tear down */
};

/**
 * Resolve the global scope to probe. Returns null in non-browser contexts (SSR) when
 * no explicit scope is supplied, so every detector short-circuits to "absent".
 */
function resolveScope(explicit?: ConsentGlobals): ConsentGlobals | null {
  if (explicit) return explicit;
  const g = globalThis as unknown as { window?: ConsentGlobals };
  if (typeof g.window !== "undefined" && g.window) return g.window;
  return null;
}

/** Index an arguments-like or array entry (gtag pushes arguments objects). */
function asIndexed(entry: unknown): { [k: number]: unknown } | null {
  if (entry != null && typeof entry === "object") {
    return entry as { [k: number]: unknown };
  }
  return null;
}

/** Narrow to a non-null plain-ish object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object";
}

/**
 * Run `fn` for side effects; swallow any throw. Isolation guarantee — a stumble in a
 * third-party global probe must never escape into the host app or the SDK.
 */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* isolation: probing foreign globals must never throw into the host */
  }
}

/** Run `fn` and return its value, or `fallback` if it throws or returns undefined. */
function safeRead<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}
