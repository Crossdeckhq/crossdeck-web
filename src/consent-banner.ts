/**
 * Crossdeck Consent — the branded, Stripe-premium consent surface.
 *
 * This is the CONSENT-MODE GUEST PRIMITIVE (Path B, CD-175 / CD-185): the
 * consent widget bundled inside the injected SDK on marketplace installs
 * (Webflow, Wix, Framer, WordPress, WooCommerce, Squarespace, Bubble) and the
 * direct install. It renders the signed-off compact bottom-left arrival banner
 * (Accept all / Manage / Reject all) and a four-switch Manage pane — Strictly
 * necessary (locked) · Analytics (anonymous) · Recognize me (identity opt-in) ·
 * Marketing — in a style-isolated Shadow DOM, and records a withdrawable,
 * auditable consent choice that gates all downstream autocapture.
 *
 * Relationship to the rest of the SDK:
 *  - It WIRES to the existing {@link ../consent ConsentManager} (analytics /
 *    marketing dimensions) — it never forks a parallel consent state. The
 *    NEW "Recognize me" switch drives an `identityOptIn` boolean that this
 *    widget only RECORDS and EMITS; another module gates `identify()` on it.
 *  - The FULL-CAPABILITY / Path-A direct build is UNAFFECTED by this file.
 *    Error tracking, host-global monkey-patching and the Trust iframe are
 *    deliberately absent here — this guest build is the leaner, review-safe
 *    consent set only (CD-175 #6 / #7, CD-185 Part 2A).
 *
 * Non-negotiables baked in (Stripe / bank grade, `trust-bank-grade-no-cleverness`):
 *  - CONSENT-FIRST — everything defaults OFF except Strictly necessary; nothing
 *    is auto-on. No capture is implied until the visitor makes a choice.
 *  - GENUINE CHOICE, NEVER A DARK PATTERN — refusing (Reject all) is exactly as
 *    prominent and one-click as accepting. No pre-ticked boxes, no nag pill.
 *  - STYLE-ISOLATED — rendered in a Shadow DOM: the host page's CSS cannot leak
 *    in, and our CSS cannot leak out. In-page, NOT an iframe.
 *  - AUDITABLE + WITHDRAWABLE — every choice is persisted with proof
 *    (categories, method, timestamp, policyVersion, id) and re-openable at any
 *    time via `[data-crossdeck-consent]` or `handle.open()`. A policyVersion
 *    bump re-prompts (re-consent).
 *  - POLICY-URL REQUIRED — in managed mode the widget will NOT render without
 *    the site owner's real privacy-policy URL; it surfaces a clear diagnostic.
 *  - DIAGNOSTIC, NEVER SILENT — risky DOM work is wrapped in `safe()`, which
 *    logs a concise `[crossdeck] consent: …` warning rather than swallowing
 *    the failure (Webflow finding #11).
 */

import type { ConsentManager } from "./consent";

/** Informational "what is Crossdeck Consent" page — the attribution/acquisition link. */
export const CONSENT_INFO_URL = "https://cross-deck.com/consent";

/** localStorage key for the auditable consent record. Origin-scoped by the browser. */
export const CONSENT_STORAGE_KEY = "crossdeck.consent.v1";

/**
 * The consent choice this widget records and emits. Strictly-necessary is always
 * on and is NOT represented here (it is not a toggleable dimension).
 *
 *  - `analytics`      → maps to ConsentManager `analytics`.
 *  - `marketing`      → maps to ConsentManager `marketing`.
 *  - `identityOptIn`  → NEW. The "Recognize me" switch. NOT a ConsentManager
 *                       dimension — the site's `identify()` is gated on it by a
 *                       separate module; here it is only recorded + emitted.
 */
export interface ConsentBannerState {
  analytics: boolean;
  marketing: boolean;
  identityOptIn: boolean;
}

/** How the visitor arrived at a choice — part of the auditable record. */
export type ConsentMethod = "accept_all" | "reject_all" | "custom";

/**
 * The auditable, withdrawable consent record. Persisted to localStorage so the
 * site owner (the data controller) can demonstrate consent if challenged.
 */
export interface ConsentRecord {
  /** The per-category choice. Strictly-necessary is implicit (always on). */
  categories: ConsentBannerState;
  /** Which control produced the choice. */
  method: ConsentMethod;
  /** Epoch ms at which the choice was recorded. */
  timestamp: number;
  /** The site's policy version in effect when consent was given. */
  policyVersion: string;
  /** Opaque unique id for this consent event. */
  id: string;
}

/**
 * Which consent regime this install runs. `managed` = Crossdeck renders the
 * banner and REQUIRES the owner's `policyUrl`. Deferral to a host CMP is handled
 * upstream (CD-185 Part 1) — a deferred install simply does not mount this widget.
 */
export type ConsentBannerMode = "managed";

/** Copy + tag for one category row in the Manage pane. Config is per-build. */
export interface ConsentCategoryConfig {
  /** Row title, e.g. "Analytics". */
  title: string;
  /** Enumerated body copy — MUST state exactly what is captured and its identity status. */
  description: string;
  /** Optional pill next to the title, e.g. { text: "Anonymous", kind: "anon" }. */
  tag?: { text: string; kind: "anon" | "locked" | "optin" };
}

/** The four-category copy set. Defaults match the signed-off Webflow build. */
export interface ConsentCategoriesConfig {
  necessary: ConsentCategoryConfig;
  analytics: ConsentCategoryConfig;
  identity: ConsentCategoryConfig;
  marketing: ConsentCategoryConfig;
}

export interface ConsentBannerOptions {
  /** Where to attach the widget host. Element or selector. Defaults to `document.body`. */
  target?: HTMLElement | string;
  /**
   * The site owner's real privacy/cookie-policy URL. REQUIRED in managed mode —
   * no dead `#`, no Crossdeck-hosted stand-in. The widget refuses to render
   * without it and logs a diagnostic (CD-185 Part 2).
   */
  policyUrl?: string;
  /** Per-category copy overrides. Omitted categories fall back to the signed-off defaults. */
  categories?: Partial<ConsentCategoriesConfig>;
  /** Called on every recorded choice with the resulting state. */
  onChange?: (state: ConsentBannerState) => void;
  /** Consent regime. Only `managed` renders a banner. Default `managed`. */
  mode?: ConsentBannerMode;
  /**
   * A previously known choice (e.g. from the site owner's server). Used to seed
   * the widget when no localStorage record is present. If it satisfies the
   * current `policyVersion`, the banner stays hidden and the choice is applied.
   */
  existingConsent?: Partial<ConsentBannerState>;
  /**
   * The site's current policy version. When it differs from the stored record's
   * version, the widget re-prompts (re-consent). Defaults to `"1"`.
   */
  policyVersion?: string;
  /**
   * The SDK's {@link ConsentManager} (or anything with a compatible `set`). The
   * widget calls `.set({ analytics, marketing })` on every choice so autocapture
   * follows consent live. `identityOptIn` is emitted separately via `onChange`.
   */
  consent?: Pick<ConsentManager, "set">;
  /** Override the info/attribution link target (tests / self-host). */
  infoUrl?: string;
}

export interface ConsentBannerHandle {
  /** The host element carrying the shadow root — for layout only; never reach inside. */
  readonly host: HTMLElement | null;
  /** Re-open the Manage pane (the withdrawal affordance). Idempotent, safe post-choice. */
  open(): void;
  /** The current persisted consent record, or `null` if none has been recorded. */
  getRecord(): ConsentRecord | null;
  /** The current in-memory state (defaults to all-off until a choice is recorded). */
  getState(): ConsentBannerState;
  /** Tear down: remove the host, delegated listener, and media subscription. Idempotent. */
  destroy(): void;
}

/** The `Crossdeck.consent` widget namespace surfaced on the SDK client. */
export interface CrossdeckConsentNamespace {
  /** Mount the branded consent banner. See {@link mountConsentBanner}. */
  banner(opts: ConsentBannerOptions): ConsentBannerHandle;
}

// The gradient-cross brand mark, rendered inline. Uses the shadow-local `#cd`
// gradient defined once in the shadow root (isolation keeps the id collision-free).
const MARK = `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="url(#cd)" d="M13.9 8.2a4 4 0 0 0-5.7 5.6L18.3 24 8.2 34.2a4 4 0 1 0 5.7 5.6L24 29.7l10.1 10.1a4 4 0 0 0 5.7-5.6L29.7 24l10.1-10.2a4 4 0 1 0-5.7-5.6L24 18.3 13.9 8.2Z"/></svg>`;

const DEFAULT_CATEGORIES: ConsentCategoriesConfig = {
  necessary: {
    title: "Strictly necessary",
    description:
      "The site's own essential cookies — sign-in, session, core function. Crossdeck sets nothing here.",
    tag: { text: "On", kind: "locked" },
  },
  analytics: {
    title: "Analytics",
    description:
      'Page views, sessions, product usage — anonymous. Identified only if you turn on "Recognize me", never automatically.',
    tag: { text: "Anonymous", kind: "anon" },
  },
  identity: {
    title: "Recognize me",
    description:
      "Link activity to your account across visits and devices. On = your explicit identity opt-in; off = anonymous even when signed in.",
    tag: { text: "Identity opt-in", kind: "optin" },
  },
  marketing: {
    title: "Marketing",
    description:
      "Referrer + ad-click IDs (gclid, fbclid…) for attribution, and a HubSpot arrival signal.",
  },
};

const DEFAULT_STATE: ConsentBannerState = {
  analytics: false,
  marketing: false,
  identityOptIn: false,
};

const STYLE = `
:host{ all: initial; }
.cd-root{
  --stage:#efe9dd; --surface:#ffffff; --surface-2:#faf7f0;
  --text:#17130f; --muted:#6b6259; --faint:#9a9088;
  --border:rgba(23,19,17,.11); --hair:rgba(23,19,17,.07);
  --accent:#ee4f25; --accent-strong:#c23a15;
  --brand-a:#FF3D2E; --brand-b:#FF9A3D;
  --track:rgba(23,19,17,.15); --lock:#efe9de;
  --shadow:0 16px 40px -14px rgba(23,19,17,.30), 0 2px 6px rgba(23,19,17,.05);
  font-family:'Inter',-apple-system,system-ui,sans-serif;
  color:var(--text); -webkit-font-smoothing:antialiased;
}
.cd-root.dark{
  --stage:#141110; --surface:#1c1917; --surface-2:#232019;
  --text:#f4efe8; --muted:#a89f95; --faint:#7c7267;
  --border:rgba(244,239,232,.13); --hair:rgba(244,239,232,.08);
  --accent:#ff6a42; --accent-strong:#ff8862;
  --track:rgba(244,239,232,.17); --lock:#2a2521;
  --shadow:0 20px 46px -14px rgba(0,0,0,.72), 0 2px 6px rgba(0,0,0,.4);
}
.cd-root *{box-sizing:border-box}
.hidden{display:none!important}
.mark{flex-shrink:0}

.dock{position:fixed;left:20px;bottom:20px;z-index:2147483000}

/* ---- ARRIVAL — slim compact banner ---- */
.arr{width:330px;background:var(--surface);border:1px solid var(--border);border-radius:15px;box-shadow:var(--shadow);
  padding:15px 16px 14px}
.arr-brand{display:flex;align-items:center;gap:7px;margin-bottom:8px}
.arr-brand .mark{width:16px;height:16px}
.arr-brand b{font-size:12.5px;font-weight:640}
.arr-brand .by{margin-left:auto;font-size:9.5px;font-weight:600;color:var(--faint);display:inline-flex;align-items:center;gap:4px;text-decoration:none}
.arr-brand .by .mark{width:10px;height:10px}
.arr-brand .by:hover{color:var(--muted)}
.arr p{font-size:12px;line-height:1.5;color:var(--muted);margin:0 0 12px}
.arr p b{color:var(--text);font-weight:600}
.arr p a{color:var(--accent-strong);font-weight:600;text-decoration:none}
.arr-btns{display:flex;align-items:center;gap:7px}
.arr-btns .btn{flex:1}

/* buttons */
.btn{font:inherit;font-family:inherit;font-size:12px;font-weight:640;padding:8px 12px;border-radius:9px;cursor:pointer;
  border:1px solid var(--border);background:var(--surface);color:var(--text);transition:transform .1s,border-color .12s}
.btn:hover{transform:translateY(-1px);border-color:var(--accent)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn.primary{border:none;color:#fff;background:linear-gradient(120deg,var(--brand-a),var(--brand-b));box-shadow:0 4px 12px -3px rgba(255,61,46,.5)}
.btn.primary:hover{border:none}

/* ---- MANAGE — compact, bottom-left, corner-anchored ---- */
.mg{width:360px;background:var(--surface);border:1px solid var(--border);border-radius:15px;box-shadow:var(--shadow);overflow:hidden}
.mg-head{padding:15px 16px 12px;border-bottom:1px solid var(--hair)}
.mg-brand{display:flex;align-items:center;gap:7px;margin-bottom:8px}
.mg-brand .mark{width:16px;height:16px}.mg-brand b{font-size:12.5px;font-weight:640}
.mg-brand .env{margin-left:auto;font-size:9.5px;font-weight:600;color:var(--faint)}
.mg-head strong{font-size:13.5px;font-weight:670;display:block}
.cats{padding:2px 16px;max-height:250px;overflow-y:auto}
.cat{padding:11px 0;border-bottom:1px solid var(--hair)}
.cat:last-child{border-bottom:0}
.cat-top{display:flex;align-items:flex-start;gap:10px}
.cat-t{display:flex;flex-direction:column;gap:2px;min-width:0}
.cat-t strong{font-size:12px;font-weight:640;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tag{font-size:8.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:1.5px 5px;border-radius:4px}
.tag.anon{background:rgba(31,157,85,.12);color:#1f9d55}
.tag.locked{background:var(--surface-2);color:var(--faint);border:1px solid var(--hair)}
.tag.optin{background:rgba(238,79,37,.12);color:var(--accent-strong)}
.cd-root.dark .tag.optin{background:rgba(255,106,66,.16)}
.cat-t span{font-size:10.5px;line-height:1.45;color:var(--muted)}
.cat-t span b{color:var(--text)}
.cat-t span code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}
.sw{margin-left:auto;margin-top:2px;flex-shrink:0;position:relative;width:36px;height:21px;border-radius:99px;background:var(--track);border:none;cursor:pointer;transition:background .18s;padding:0}
.sw::after{content:"";position:absolute;top:2.5px;left:2.5px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .18s}
.sw.on{background:linear-gradient(120deg,var(--brand-a),var(--brand-b))}
.sw.on::after{transform:translateX(15px)}
.sw:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sw.locked{background:var(--lock);cursor:not-allowed}
.sw.locked::after{background:linear-gradient(120deg,var(--brand-a),var(--brand-b));transform:translateX(15px);box-shadow:none}
.mg-actions{padding:12px 16px;display:flex;gap:7px;background:var(--surface-2);border-top:1px solid var(--hair)}
.mg-actions .btn{flex:1}
.mg-foot{padding:9px 16px;display:flex;align-items:center;justify-content:space-between;background:var(--surface-2);border-top:1px solid var(--hair)}
.mg-foot a{font-size:10px;font-weight:600;color:var(--faint);display:inline-flex;align-items:center;gap:5px;text-decoration:none}
.mg-foot a .mark{width:11px;height:11px}
.mg-foot a:hover{color:var(--muted)}
.mg-foot span{font-size:9px;color:var(--faint)}
`;

/**
 * Mount the Crossdeck Consent banner. Framework-agnostic and guaranteed not to
 * throw — any construction failure is logged and an inert handle returned so the
 * host app is never destabilised by our consent surface.
 */
export function mountConsentBanner(
  opts: ConsentBannerOptions,
): ConsentBannerHandle {
  const mode: ConsentBannerMode = opts.mode || "managed";
  const policyUrl = typeof opts.policyUrl === "string" ? opts.policyUrl.trim() : "";
  const policyVersion =
    typeof opts.policyVersion === "string" && opts.policyVersion
      ? opts.policyVersion
      : "1";
  const infoUrl = normalizeUrl(opts.infoUrl) || CONSENT_INFO_URL;
  const cats = mergeCategories(opts.categories);

  // Mutable widget state — the single source of truth for switch positions.
  const state: ConsentBannerState = { ...DEFAULT_STATE };

  let hostEl: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let rootEl: HTMLElement | null = null;
  let arrEl: HTMLElement | null = null;
  let mgEl: HTMLElement | null = null;
  let mql: MediaQueryList | null = null;
  let onScheme: ((e: MediaQueryListEvent) => void) | null = null;
  let onDelegatedClick: ((e: Event) => void) | null = null;
  let record: ConsentRecord | null = null;
  let destroyed = false;

  // --- managed mode requires the owner's real policy URL (CD-185 Part 2) ---
  if (mode === "managed" && !policyUrl) {
    warn(
      "policyUrl is required in managed mode — refusing to render a policy-less banner. Pass opts.policyUrl (the site owner's real privacy-policy URL).",
    );
    return makeInertHandle();
  }

  if (typeof window === "undefined" || typeof document === "undefined") {
    warn("no DOM available (SSR / non-browser) — consent banner not mounted.");
    return makeInertHandle();
  }

  // --- resolve prior consent: stored record wins, else existingConsent seed ---
  record = readRecord();
  const stale = record !== null && record.policyVersion !== policyVersion;
  let alreadyConsented = false;

  if (record && !stale) {
    Object.assign(state, record.categories);
    alreadyConsented = true;
  } else if (!record && opts.existingConsent) {
    // Seed from an integrator-supplied prior choice; treat as current-policy consent.
    Object.assign(state, sanitizeState(opts.existingConsent));
    alreadyConsented = true;
  }

  // Build the shadow-isolated UI up front so `open()` works whether or not the
  // arrival banner is shown on load.
  safe(() => build(), "failed to build widget");

  if (alreadyConsented) {
    // Consent already on file for this policy — apply it, keep the surface hidden,
    // but keep the reopen affordance live so withdrawal stays as easy as granting.
    applyToManager();
    emit();
    hideAll();
  } else {
    // Fresh visitor, or the policy changed (re-consent) — prompt.
    showArrival();
  }

  bindDelegatedReopen();
  subscribeScheme();

  return {
    get host() {
      return hostEl;
    },
    open: openManage,
    getRecord() {
      return record ? { ...record, categories: { ...record.categories } } : null;
    },
    getState() {
      return { ...state };
    },
    destroy,
  };

  // ---------------------------------------------------------------- build ----

  function build(): void {
    hostEl = document.createElement("div");
    hostEl.setAttribute("data-crossdeck-consent-host", "");
    // Keep the host out of the host page's layout/flow; the dock is fixed.
    hostEl.style.cssText = "position:static;all:initial;";

    root = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE;
    root.appendChild(style);

    rootEl = document.createElement("div");
    rootEl.className = "cd-root";
    rootEl.innerHTML = template();
    root.appendChild(rootEl);

    arrEl = rootEl.querySelector(".arr");
    mgEl = rootEl.querySelector(".mg");

    // Fill in owner-configured URLs programmatically (never via innerHTML) so a
    // hostile URL can't break out of the attribute context.
    setHref(rootEl.querySelector(".arr .policy-link"), policyUrl);
    setHref(rootEl.querySelector(".by"), infoUrl);
    setHref(rootEl.querySelector(".mg-foot a"), infoUrl);

    wireControls();
    syncSwitches();

    const parent = resolveTarget(opts.target) || document.body;
    if (!parent) {
      warn("no mount target and no document.body — consent banner not attached.");
      return;
    }
    parent.appendChild(hostEl);
  }

  function template(): string {
    const gradient = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="cd" x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FF3D2E"/><stop offset="1" stop-color="#FF9A3D"/></linearGradient></defs></svg>`;
    return (
      gradient +
      `<div class="dock">` +
      arrivalMarkup() +
      manageMarkup() +
      `</div>`
    );
  }

  function arrivalMarkup(): string {
    return (
      `<div class="arr" role="dialog" aria-label="Your privacy" aria-modal="false">` +
      `<div class="arr-brand">${MARK}<b>Your privacy</b>` +
      `<a class="by" target="_blank" rel="noopener">${MARK}by Crossdeck</a></div>` +
      `<p><b>You choose what's collected.</b> Nothing but essentials runs until you say so. ` +
      `<a class="policy-link" target="_blank" rel="noopener">Privacy policy</a>.</p>` +
      `<div class="arr-btns">` +
      `<button type="button" class="btn primary" data-act="accept_all">Accept all</button>` +
      `<button type="button" class="btn" data-act="manage">Manage</button>` +
      `<button type="button" class="btn" data-act="reject_all">Reject all</button>` +
      `</div></div>`
    );
  }

  function manageMarkup(): string {
    return (
      `<div class="mg hidden" role="dialog" aria-label="Manage privacy preferences" aria-modal="false">` +
      `<div class="mg-head"><div class="mg-brand">${MARK}<b>Your privacy</b>` +
      `<span class="env">This site uses Crossdeck</span></div>` +
      `<strong>Manage preferences</strong></div>` +
      `<div class="cats">` +
      catRow(cats.necessary, null, true) +
      catRow(cats.analytics, "analytics", false) +
      catRow(cats.identity, "identityOptIn", false) +
      catRow(cats.marketing, "marketing", false) +
      `</div>` +
      `<div class="mg-actions">` +
      `<button type="button" class="btn" data-act="reject_all">Reject all</button>` +
      `<button type="button" class="btn" data-act="accept_all">Accept all</button>` +
      `<button type="button" class="btn primary" data-act="save">Save</button>` +
      `</div>` +
      `<div class="mg-foot"><a target="_blank" rel="noopener">${MARK}Consent by Crossdeck</a>` +
      `<span>processes data on this site's behalf</span></div>` +
      `</div>`
    );
  }

  function catRow(
    cfg: ConsentCategoryConfig,
    key: keyof ConsentBannerState | null,
    locked: boolean,
  ): string {
    const tag = cfg.tag
      ? `<span class="tag ${cfg.tag.kind}">${escapeHtml(cfg.tag.text)}</span>`
      : "";
    const sw = locked
      ? `<button type="button" class="sw locked" disabled aria-label="${escapeHtml(cfg.title)} (always on)"></button>`
      : `<button type="button" class="sw" role="switch" aria-checked="false" data-cat="${String(key)}" aria-label="${escapeHtml(cfg.title)}"></button>`;
    return (
      `<div class="cat"><div class="cat-top"><div class="cat-t">` +
      `<strong>${escapeHtml(cfg.title)} ${tag}</strong>` +
      `<span>${escapeHtml(cfg.description)}</span></div>${sw}</div></div>`
    );
  }

  // ------------------------------------------------------------- wiring ----

  function wireControls(): void {
    if (!rootEl) return;
    const buttons = rootEl.querySelectorAll<HTMLButtonElement>("[data-act]");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.getAttribute("data-act");
        if (act === "manage") showManage();
        else if (act === "accept_all") choose("accept_all");
        else if (act === "reject_all") choose("reject_all");
        else if (act === "save") choose("custom");
      });
    });
    const switches = rootEl.querySelectorAll<HTMLButtonElement>(".sw[data-cat]");
    switches.forEach((el) => {
      el.addEventListener("click", () => {
        const key = el.getAttribute("data-cat") as keyof ConsentBannerState | null;
        if (!key) return;
        state[key] = !state[key];
        syncSwitches();
      });
    });
  }

  /** Reflect `state` onto the switch DOM (class + aria). */
  function syncSwitches(): void {
    if (!rootEl) return;
    rootEl.querySelectorAll<HTMLButtonElement>(".sw[data-cat]").forEach((el) => {
      const key = el.getAttribute("data-cat") as keyof ConsentBannerState | null;
      if (!key) return;
      const on = state[key] === true;
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", on ? "true" : "false");
    });
  }

  // ------------------------------------------------------------ choices ----

  function choose(method: ConsentMethod): void {
    if (method === "accept_all") {
      state.analytics = true;
      state.marketing = true;
      state.identityOptIn = true;
    } else if (method === "reject_all") {
      state.analytics = false;
      state.marketing = false;
      state.identityOptIn = false;
    }
    // `custom` keeps the current per-switch state as-is.
    syncSwitches();
    persist(method);
    applyToManager();
    emit();
    hideAll();
  }

  function persist(method: ConsentMethod): void {
    record = {
      categories: { ...state },
      method,
      timestamp: Date.now(),
      policyVersion,
      id: makeId(),
    };
    safe(() => {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
    }, "could not persist consent record to localStorage");
  }

  function applyToManager(): void {
    if (!opts.consent) return;
    safe(() => {
      opts.consent?.set({ analytics: state.analytics, marketing: state.marketing });
    }, "could not apply consent to the ConsentManager");
  }

  function emit(): void {
    if (!opts.onChange) return;
    safe(() => opts.onChange?.({ ...state }), "onChange callback threw");
  }

  // -------------------------------------------------------- visibility ----

  function showArrival(): void {
    toggle(arrEl, true);
    toggle(mgEl, false);
  }

  function showManage(): void {
    syncSwitches();
    toggle(arrEl, false);
    toggle(mgEl, true);
  }

  function hideAll(): void {
    // After a choice the widget DISAPPEARS COMPLETELY — no floating pill.
    toggle(arrEl, false);
    toggle(mgEl, false);
  }

  function openManage(): void {
    if (destroyed) return;
    safe(() => showManage(), "could not reopen the Manage pane");
  }

  function toggle(el: HTMLElement | null, visible: boolean): void {
    if (el) el.classList.toggle("hidden", !visible);
  }

  // ----------------------------------------------------- reopen / theme ----

  function bindDelegatedReopen(): void {
    onDelegatedClick = (e: Event) => {
      const path = e.composedPath ? e.composedPath() : [];
      for (const node of path) {
        if (node instanceof Element && node.closest("[data-crossdeck-consent]")) {
          e.preventDefault();
          openManage();
          return;
        }
      }
      // Fallback for environments without composedPath.
      const t = e.target;
      if (t instanceof Element && t.closest("[data-crossdeck-consent]")) {
        e.preventDefault();
        openManage();
      }
    };
    safe(
      () => document.addEventListener("click", onDelegatedClick as EventListener),
      "could not bind [data-crossdeck-consent] reopen listener",
    );
  }

  function subscribeScheme(): void {
    safe(() => {
      mql = window.matchMedia("(prefers-color-scheme: dark)");
      applyScheme(mql.matches);
      onScheme = (e: MediaQueryListEvent) => applyScheme(e.matches);
      // addEventListener is the modern API; older Safari only has addListener.
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onScheme);
      } else if (typeof mql.addListener === "function") {
        mql.addListener(onScheme);
      }
    }, "could not subscribe to prefers-color-scheme");
  }

  function applyScheme(dark: boolean): void {
    if (rootEl) rootEl.classList.toggle("dark", dark);
  }

  // -------------------------------------------------------- lifecycle ----

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (onDelegatedClick) {
      safe(
        () => document.removeEventListener("click", onDelegatedClick as EventListener),
        "could not remove reopen listener",
      );
    }
    if (mql && onScheme) {
      safe(() => {
        if (typeof mql?.removeEventListener === "function") {
          mql.removeEventListener("change", onScheme as (e: MediaQueryListEvent) => void);
        } else if (typeof mql?.removeListener === "function") {
          mql.removeListener(onScheme as (e: MediaQueryListEvent) => void);
        }
      }, "could not remove scheme listener");
    }
    safe(() => hostEl?.parentNode?.removeChild(hostEl as HTMLElement), "could not remove host node");
  }

  // ------------------------------------------------------------ helpers ----

  function readRecord(): ConsentRecord | null {
    let raw: string | null = null;
    safe(() => {
      raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    }, "could not read consent record from localStorage");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<ConsentRecord>;
      if (!parsed || typeof parsed !== "object" || !parsed.categories) return null;
      return {
        categories: sanitizeState(parsed.categories),
        method: (parsed.method as ConsentMethod) || "custom",
        timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
        policyVersion:
          typeof parsed.policyVersion === "string" ? parsed.policyVersion : "1",
        id: typeof parsed.id === "string" ? parsed.id : makeId(),
      };
    } catch (err) {
      warn("stored consent record was not valid JSON — ignoring it.", err);
      return null;
    }
  }

  function makeInertHandle(): ConsentBannerHandle {
    return {
      host: null,
      open() {
        warn("open() called but the banner did not mount (see prior warning).");
      },
      getRecord() {
        return null;
      },
      getState() {
        return { ...DEFAULT_STATE };
      },
      destroy() {
        /* nothing was mounted */
      },
    };
  }
}

// ============================================================
// Module-level pure helpers
// ============================================================

function mergeCategories(
  overrides?: Partial<ConsentCategoriesConfig>,
): ConsentCategoriesConfig {
  if (!overrides) return DEFAULT_CATEGORIES;
  return {
    necessary: overrides.necessary || DEFAULT_CATEGORIES.necessary,
    analytics: overrides.analytics || DEFAULT_CATEGORIES.analytics,
    identity: overrides.identity || DEFAULT_CATEGORIES.identity,
    marketing: overrides.marketing || DEFAULT_CATEGORIES.marketing,
  };
}

function sanitizeState(partial: Partial<ConsentBannerState>): ConsentBannerState {
  return {
    analytics: partial.analytics === true,
    marketing: partial.marketing === true,
    identityOptIn: partial.identityOptIn === true,
  };
}

function resolveTarget(target?: HTMLElement | string): HTMLElement | null {
  try {
    if (!target) return null;
    if (typeof target === "string") return document.querySelector(target);
    return target;
  } catch (err) {
    warn("could not resolve mount target", err);
    return null;
  }
}

function setHref(el: Element | null, url: string): void {
  if (!el) return;
  const safeUrl = normalizeUrl(url);
  if (safeUrl) {
    el.setAttribute("href", safeUrl);
  } else if (url) {
    // A non-http(s) or malformed URL was supplied — do not render it as a link.
    el.removeAttribute("href");
    warn("refusing to set a non-http(s) URL as a link: " + String(url));
  }
}

/** Only http(s) URLs are allowed as rendered links (blocks javascript:/data: etc). */
function normalizeUrl(url?: string): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url, typeof location !== "undefined" ? location.href : undefined);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function makeId(): string {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch (err) {
    warn("crypto.randomUUID unavailable — falling back to a random id", err);
  }
  return "cdc_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Run risky DOM work, surfacing (never swallowing) any failure as a concise
 * `[crossdeck] consent: …` warning. Webflow finding #11: no empty catch blocks.
 */
function safe(fn: () => void, context: string): void {
  try {
    fn();
  } catch (err) {
    warn(context, err);
  }
}

function warn(message: string, err?: unknown): void {
  try {
    const prefix = "[crossdeck] consent: " + message;
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      if (err !== undefined) console.warn(prefix, err);
      else console.warn(prefix);
    }
  } catch {
    // console itself is unavailable — nothing further we can safely do.
  }
}
