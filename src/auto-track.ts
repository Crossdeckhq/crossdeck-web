/**
 * Auto-tracking — sessions and SPA page views, emitted via the same
 * track() pipeline as developer-instrumented events. No-op outside
 * browsers (Node, Workers).
 *
 * Sessions:
 *   - One sessionId per "alive in foreground" window.
 *   - `session.started` fires on install (after start()).
 *   - `session.ended` fires on visibilitychange→hidden, beforeunload,
 *     and pagehide. Multiple end-triggers are deduplicated so we don't
 *     emit two `session.ended` events for one tab close.
 *   - `session.duration_ms` attached on end.
 *   - If the tab returns to foreground after >30 minutes idle, the next
 *     visibilitychange→visible mints a NEW sessionId — matches the
 *     30-min session-window convention used by GA4 / Mixpanel / etc.
 *
 * Page views:
 *   - `page.viewed` fires on initial install.
 *   - Hooks into `history.pushState` / `history.replaceState` (monkey-
 *     patched in a non-destructive way so other libraries that hook
 *     them still see their events) and `popstate` for SPA navigation.
 *   - Properties: path, url, title, referrer, search, hash.
 *
 * Privacy: this module emits names + properties only. The Crossdeck
 * client adds device info on top via track(). Nothing here collects
 * PII beyond the URL itself, and we don't even log query strings
 * separately from the path (developer can post-process if needed).
 */

import { randomChars } from "./identity";

export interface AutoTrackConfig {
  sessions: boolean;
  pageViews: boolean;
  /** Whether to enrich every event with device info. Lives on the client, not here, but documented together. */
  deviceInfo: boolean;
  /**
   * Click autocapture. When true, the SDK installs a global click
   * listener that fires `element.clicked` for every interactive
   * click. Captures the target element's selector, text content,
   * tag, href, data-* attributes, and viewport coordinates — enough
   * to power funnel attribution ("clicked X then converted") and
   * heatmap visualisation. Mixpanel / Amplitude default. Privacy
   * guardrails baked in (input/password/sensitive-class skips).
   *
   * Default ON because behavioural attribution is Crossdeck's USP.
   * Set to false to disable autocapture entirely (developer adds
   * track() calls manually).
   */
  clicks: boolean;
  /** Capture Web Vitals (LCP/INP/CLS/FCP/TTFB). Default true (browser only). */
  webVitals: boolean;
  /** Capture uncaught errors + unhandled rejections + 5xx fetch/XHR. Default true (browser only). */
  errors: boolean;
}

export const DEFAULT_AUTO_TRACK: AutoTrackConfig = {
  sessions: true,
  pageViews: true,
  deviceInfo: true,
  clicks: true,
  webVitals: true,
  errors: true,
};

/** Reopen as a new session if the tab was hidden longer than this. */
const SESSION_RESUME_THRESHOLD_MS = 30 * 60 * 1000;

type TrackFn = (name: string, properties?: Record<string, unknown>) => void;

interface SessionState {
  sessionId: string;
  startedAt: number;
  hiddenAt: number | null;
  endedSent: boolean;
  /**
   * Acquisition context captured once at session start. GA4 calls
   * this "first-touch attribution within the session." We attach
   * these to every event of the session so dashboards can answer
   * "what was the source of users who triggered paywall_shown" — a
   * per-event lookup against the captured-once state, not a re-parse
   * of the URL on every track().
   *
   * Empty strings (not undefined) so JSON envelope serialisation
   * stays uniform — backend's extractAcquisition handles "" the
   * same as missing.
   */
  acquisition: SessionAcquisition;
}

export interface SessionAcquisition {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  referrer: string;
  // ---------- paid-traffic click IDs (v0.9.0+) ----------
  // UTM parameters are a documentation convention — anyone writing
  // ads can forget to add them, and many platforms (Performance Max,
  // Display & Video 360, automated bidding) emit ONLY a click-id.
  // Capturing these alongside UTMs catches the ~40% of paid traffic
  // that UTMs miss. Each is the platform's stable click identifier
  // that flows from ad-click → landing-page URL → conversion event.
  /** Google Ads click identifier. */
  gclid: string;
  /** Facebook / Meta Ads click identifier. */
  fbclid: string;
  /** Microsoft Advertising (Bing) click identifier. */
  msclkid: string;
  /** TikTok Ads click identifier. */
  ttclid: string;
  /** LinkedIn Ads click identifier. */
  li_fat_id: string;
  /** Twitter / X Ads click identifier. */
  twclid: string;
}

const EMPTY_ACQUISITION: SessionAcquisition = {
  utm_source: "",
  utm_medium: "",
  utm_campaign: "",
  utm_content: "",
  utm_term: "",
  referrer: "",
  gclid: "",
  fbclid: "",
  msclkid: "",
  ttclid: "",
  li_fat_id: "",
  twclid: "",
};

export class AutoTracker {
  private session: SessionState | null = null;
  private cleanups: Array<() => void> = [];
  /**
   * Stable per-page-view identifier. Minted at every `page.viewed`
   * emission and attached to every subsequent event until the next
   * `page.viewed`. Lets dashboards correlate "user clicked X" to
   * "user viewed page Y" without timestamp arithmetic — the canonical
   * Mixpanel `$current_url` / Segment `pageId` pattern.
   *
   * Null until the first `page.viewed` fires (which happens at SDK
   * install if `autoTrack.pageViews !== false`).
   */
  private pageviewId: string | null = null;

  constructor(
    private readonly cfg: AutoTrackConfig,
    private readonly track: TrackFn,
  ) {}

  install(): void {
    if (!isBrowserSafe()) return;
    if (this.cfg.sessions) this.installSessionTracking();
    if (this.cfg.pageViews) this.installPageViewTracking();
    if (this.cfg.clicks) this.installClickTracking();
  }

  uninstall(): void {
    while (this.cleanups.length) {
      const fn = this.cleanups.pop();
      try { fn?.(); } catch { /* ignore */ }
    }
    if (this.session && !this.session.endedSent) {
      this.emitSessionEnd();
    }
    this.session = null;
  }

  /** Exposed for tests + consumers that want to reset the session manually. */
  resetSession(): void {
    if (this.session && !this.session.endedSent) this.emitSessionEnd();
    this.session = this.startNewSession();
    this.emitSessionStart();
  }

  /** Exposed for inspection/tests — returns the current sessionId (or null if not in a session). */
  get currentSessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  /** Stable per-page-view ID. Null before the first page.viewed has fired. */
  get currentPageviewId(): string | null {
    return this.pageviewId;
  }

  /**
   * Per-session acquisition context — utm_* + referrer, captured once
   * at session start. Returns empty strings when there's no session
   * (Node, before init, after uninstall) so callers can spread without
   * conditional logic. Bank-grade rule: capture once, attach to every
   * event of the session, don't re-read on every track() (the URL
   * changes via SPA pushState; the source-of-record is the URL we
   * landed on).
   */
  get currentAcquisition(): SessionAcquisition {
    return this.session?.acquisition ?? EMPTY_ACQUISITION;
  }

  // ---------- sessions ----------
  private installSessionTracking(): void {
    this.session = this.startNewSession();
    this.emitSessionStart();

    const onVisChange = (): void => {
      if (!this.session) return;
      const doc = (globalThis as { document: Document }).document;
      if (doc.visibilityState === "hidden") {
        // Quick tab switches and Cmd-Tabs land here, but the page is
        // still alive. Record the time; do NOT emit session.ended yet.
        // pagehide / beforeunload are the canonical end signals
        // (mobile backgrounding fires pagehide reliably). If we ended
        // here, returning to the tab seconds later would always start
        // a new session — defeating the 30-min session-window intent.
        this.session.hiddenAt = Date.now();
      } else if (doc.visibilityState === "visible") {
        const hiddenFor = this.session.hiddenAt
          ? Date.now() - this.session.hiddenAt
          : 0;
        if (hiddenFor >= SESSION_RESUME_THRESHOLD_MS) {
          // Long idle → end the previous session, start a fresh one.
          this.emitSessionEnd();
          this.session = this.startNewSession();
          this.emitSessionStart();
        } else {
          // Quick return — same session continues.
          this.session.hiddenAt = null;
        }
      }
    };

    const onPageHide = (): void => this.emitSessionEnd();

    const w = (globalThis as { window: Window }).window;
    const doc = (globalThis as { document: Document }).document;
    doc.addEventListener("visibilitychange", onVisChange);
    w.addEventListener("pagehide", onPageHide);
    // beforeunload is unreliable on mobile; pagehide is the modern equivalent.
    // We listen to both for desktop-vs-mobile coverage.
    w.addEventListener("beforeunload", onPageHide);

    this.cleanups.push(() => {
      doc.removeEventListener("visibilitychange", onVisChange);
      w.removeEventListener("pagehide", onPageHide);
      w.removeEventListener("beforeunload", onPageHide);
    });
  }

  private startNewSession(): SessionState {
    return {
      sessionId: mintSessionId(),
      startedAt: Date.now(),
      hiddenAt: null,
      endedSent: false,
      acquisition: captureAcquisition(),
    };
  }

  private emitSessionStart(): void {
    if (!this.session) return;
    this.track("session.started", { sessionId: this.session.sessionId });
  }

  private emitSessionEnd(): void {
    if (!this.session || this.session.endedSent) return;
    const duration = Date.now() - this.session.startedAt;
    this.track("session.ended", {
      sessionId: this.session.sessionId,
      durationMs: duration,
    });
    this.session.endedSent = true;
  }

  // ---------- page views ----------
  private installPageViewTracking(): void {
    const w = (globalThis as { window: Window }).window;
    const doc = (globalThis as { document: Document }).document;

    // PwC M-5: dedup. SPA frameworks (Next.js, React Router, Vue
    // Router) routinely fire pushState() back-to-back during a single
    // navigation — animation enter, then the destination's settle.
    // Without a guard, we'd send 2-3 page.viewed events per click,
    // inflating pageview / session counts. Dedup window: 250ms,
    // keyed by URL. Identical URL within window = drop.
    //
    // EXCEPTION: popstate (user back/forward) is always a real
    // navigation, even if it lands on a URL we've recently seen.
    // Force-fire on popstate so back-button traffic is never dropped.
    let lastFiredAt = 0;
    let lastFiredUrl = "";
    const DEDUP_WINDOW_MS = 250;

    const fire = (force = false): void => {
      const loc = w.location;
      const url = loc.href;
      const now = Date.now();
      if (!force && url === lastFiredUrl && now - lastFiredAt < DEDUP_WINDOW_MS) return;
      lastFiredAt = now;
      lastFiredUrl = url;

      // Mint a fresh pageviewId BEFORE emitting the event so this
      // page.viewed itself carries it, and every subsequent event up
      // to the next page.viewed inherits it via the auto-attached
      // enrichment in crossdeck.ts:track().
      this.pageviewId = `pv_${Date.now().toString(36)}${randomChars(10)}`;

      this.track("page.viewed", {
        pageviewId: this.pageviewId,
        path: loc.pathname,
        url,
        search: loc.search || undefined,
        hash: loc.hash || undefined,
        title: doc.title,
        // referrer only on the first hit of the session — afterward it's
        // always our previous URL, which isn't useful.
        referrer: doc.referrer || undefined,
      });
    };

    // Initial page view
    fire();

    // SPA navigation: monkey-patch pushState / replaceState. Capture the
    // BARE function references (not bound) so uninstall restores exactly
    // what was there. Bind chains accumulate without limit if every
    // install/uninstall cycle wraps with .bind() — over many cycles
    // pushState becomes [bound bound bound … pushState] and tests that
    // assert "pushState restored to its previous value" break.
    //
    // We use `function (this: History, ...args)` so JS's normal method-call
    // semantics bind `this` to history when our wrapper is invoked as
    // history.pushState(...). Then we forward via .apply(this, args) — no
    // pre-binding needed, no chain growth.
    type HistoryFn = (data: unknown, unused: string, url?: string | null) => void;
    const origPush = w.history.pushState as HistoryFn;
    const origReplace = w.history.replaceState as HistoryFn;

    function patchedPush(this: History, data: unknown, unused: string, url?: string | null): void {
      origPush.apply(this, [data, unused, url]);
      queueMicrotask(fire);
    }
    function patchedReplace(this: History, data: unknown, unused: string, url?: string | null): void {
      origReplace.apply(this, [data, unused, url]);
      queueMicrotask(fire);
    }

    (w.history.pushState as HistoryFn) = patchedPush;
    (w.history.replaceState as HistoryFn) = patchedReplace;

    // popstate fires on user back/forward — bypass the dedup window
    // because user navigation is always a real event, not a framework
    // double-fire artefact.
    const onPopState = (): void => fire(true);
    w.addEventListener("popstate", onPopState);

    this.cleanups.push(() => {
      // Only restore if WE'RE still the active wrapper. If another tracker
      // installed on top of ours, blindly setting pushState back would
      // unwind their patch too. Conservative: only restore our slot.
      if (w.history.pushState === patchedPush) {
        (w.history.pushState as HistoryFn) = origPush;
      }
      if (w.history.replaceState === patchedReplace) {
        (w.history.replaceState as HistoryFn) = origReplace;
      }
      w.removeEventListener("popstate", onPopState);
    });
  }

  // ---------- click autocapture ----------
  /**
   * Global click tracking — Mixpanel / Amplitude style autocapture.
   * Fires `element.clicked` for every interactive click with the
   * target element's selector path, text content, tag, href, data-*
   * attributes, and viewport coordinates. Powers the funnel /
   * attribution USP: "users who clicked X then converted within
   * 7 days." Default ON because behavioural attribution is the
   * core product promise.
   *
   * Privacy guardrails:
   *   - Skip clicks ON inputs / textareas / selects (form interaction
   *     isn't button telemetry; the dev should track form submits
   *     deliberately via track('form_submitted'))
   *   - Skip clicks INSIDE [type="password"] and password-class
   *     elements
   *   - Skip clicks inside elements opted out via class="cd-noTrack"
   *     or data-cd-noTrack attribute (Mixpanel's exact opt-out
   *     idiom — most devs already know it)
   *   - Capture text content but cap at 64 chars and trim — never
   *     more than what you'd see on a button label
   *
   * Volume guardrails:
   *   - Coalesce double-clicks within 100ms (React's synthetic click
   *     pattern + browser's native dblclick can fire twice)
   *   - Listen on document at capture phase so we see the click
   *     before any framework's own handlers stop propagation
   */
  private installClickTracking(): void {
    const w = (globalThis as { window: Window }).window;
    const doc = (globalThis as { document: Document }).document;

    let lastFiredAt = 0;
    let lastFiredTarget: EventTarget | null = null;
    const COALESCE_MS = 100;
    const TEXT_CAP = 64;

    const onClick = (ev: MouseEvent): void => {
      const target = ev.target as Element | null;
      if (!target || !(target instanceof Element)) return;

      // De-dupe rapid double-fires on the same target (React synthetic
      // click + browser native click can land in the same tick).
      const now = Date.now();
      if (target === lastFiredTarget && now - lastFiredAt < COALESCE_MS) return;
      lastFiredAt = now;
      lastFiredTarget = target;

      // Walk up to the nearest "actionable" ancestor. A click inside
      // <button><span>Sign up</span></button> should fire as a click
      // on the BUTTON, not the inner span. We climb up to a button /
      // a / [role="button"] / [data-cd-event] / [onclick] — whichever
      // is closer.
      const actionable = closestActionable(target);
      const clicked: Element = actionable || target;

      // Privacy: skip form-input clicks, password fields, opted-out
      // subtrees. PII risk is too high to capture text from these.
      if (isFormInput(clicked)) return;
      if (isInOptedOut(clicked)) return;
      if (isInsidePasswordField(clicked)) return;

      // Build the event properties.
      const tag = clicked.tagName.toLowerCase();
      const text = trimText(extractText(clicked), TEXT_CAP);
      const href = (clicked as HTMLAnchorElement).href || undefined;
      const linkTarget = (clicked as HTMLAnchorElement).target || undefined;
      const elementId = clicked.id || undefined;
      const role = clicked.getAttribute("role") || undefined;
      const ariaLabel = clicked.getAttribute("aria-label") || undefined;
      const selector = buildSelector(clicked);
      const dataAttrs = collectDataAttrs(clicked);
      const isLink = tag === "a" && !!href;

      // Optional explicit override: if the dev tagged the element
      // with data-cd-event="custom_name", we use THAT as the event
      // name and stash the auto-properties as `meta` rather than
      // firing as element.clicked. Devs who want named events get
      // them; everyone else gets the auto.
      const explicitName = clicked.getAttribute("data-cd-event");

      const props: Record<string, unknown> = {
        selector,
        tag,
        text,
        elementId,
        role,
        ariaLabel,
        href,
        isLink,
        linkTarget,
        viewportX: ev.clientX,
        viewportY: ev.clientY,
        pageX: ev.pageX,
        pageY: ev.pageY,
        ...dataAttrs,
      };
      // Drop empties so the event property bag isn't full of nulls.
      for (const k of Object.keys(props)) {
        if (props[k] === undefined || props[k] === null || props[k] === "") delete props[k];
      }

      this.track(explicitName || "element.clicked", props);
    };

    doc.addEventListener("click", onClick, { capture: true, passive: true });
    this.cleanups.push(() => {
      doc.removeEventListener("click", onClick, { capture: true } as AddEventListenerOptions);
    });
  }
}

// ---------- click-tracking helpers ----------

function closestActionable(el: Element): Element | null {
  // Climb up to the nearest interactive ancestor. The order matters —
  // [data-cd-event] wins because it's an explicit dev-supplied tag.
  return (
    el.closest("[data-cd-event]") ||
    el.closest("[data-cd-noTrack]") ||
    el.closest("button, a, [role='button'], [role='link'], input[type='button'], input[type='submit']") ||
    null
  );
}

function isFormInput(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = ((el as HTMLInputElement).type || "").toLowerCase();
    // Buttons are inputs but they ARE click targets — track them.
    return type !== "button" && type !== "submit" && type !== "image" && type !== "reset";
  }
  return false;
}

function isInOptedOut(el: Element): boolean {
  // Mixpanel's idiom: class="cd-noTrack" or [data-cd-noTrack] on any
  // ancestor opts the entire subtree out of autocapture.
  if (el.closest('[data-cd-noTrack], [data-cd-no-track], .cd-noTrack, .cd-no-track')) return true;
  return false;
}

function isInsidePasswordField(el: Element): boolean {
  // Defensive: never capture clicks on / near password fields.
  if (el.closest('input[type="password"]')) return true;
  return false;
}

/**
 * Compute the best human-readable label for a clicked element.
 *
 * Precedence (highest → lowest):
 *   1. data-cd-track / data-track / data-testid — explicit dev label
 *   2. aria-label — accessible name (most icon-only buttons set this)
 *   3. aria-labelledby — references another element by ID
 *   4. <input value="…"> — for submit/button inputs
 *   5. visible textContent — the most common case
 *   6. title attribute — tooltip fallback
 *   7. <img alt="…"> inside the element — for image-only buttons
 *   8. <svg><title>…</title></svg> inside the element — for SVG icons
 *      that include an accessible name
 *
 * Returns "" only when the element is truly anonymous (no label, no
 * text, no inner image/icon with a name). The journey UI falls back
 * to the selector when this returns empty, so any source we can lift
 * a name from beats the CSS-homework display.
 *
 * Whitespace is always collapsed — "  Sign\n  up  " → "Sign up".
 */
function extractText(el: Element): string {
  const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

  // 1. Explicit dev-supplied labels. data-cd-track is the Crossdeck-
  //    canonical attribute; data-track and data-testid are the
  //    common community standards we accept as synonyms.
  const explicit =
    el.getAttribute("data-cd-track") ||
    el.getAttribute("data-track") ||
    el.getAttribute("data-testid");
  if (explicit) {
    const t = clean(explicit);
    if (t) return t;
  }

  // 2. Aria-label — the ARIA accessible-name primary source.
  const aria = el.getAttribute("aria-label");
  if (aria) {
    const t = clean(aria);
    if (t) return t;
  }

  // 3. Aria-labelledby — resolve referenced element's text. The ID
  //    list can have multiple tokens; concatenate referents (ARIA spec).
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy && typeof el.ownerDocument?.getElementById === "function") {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      const ref = el.ownerDocument.getElementById(id);
      const t = ref?.textContent ? clean(ref.textContent) : "";
      if (t) parts.push(t);
    }
    if (parts.length > 0) return parts.join(" ");
  }

  // 4. Input value (submit/button inputs render their label here).
  if (el instanceof HTMLInputElement && el.value) {
    const t = clean(el.value);
    if (t) return t;
  }

  // 5. Visible textContent — the everyday case.
  const text = clean(el.textContent || "");
  if (text) return text;

  // 6. Title attribute (tooltip-style accessible name).
  const title = el.getAttribute("title");
  if (title) {
    const t = clean(title);
    if (t) return t;
  }

  // 7. <img alt="…"> within — common for image-only buttons. Prefer
  //    a non-empty alt; treat alt="" (decorative) as no signal.
  const img = el.querySelector("img[alt]");
  if (img) {
    const alt = img.getAttribute("alt") ?? "";
    const t = clean(alt);
    if (t) return t;
  }

  // 8. SVG <title> child — the conventional way to ship an accessible
  //    name on inline icons.
  const svgTitle = el.querySelector("svg title");
  if (svgTitle?.textContent) {
    const t = clean(svgTitle.textContent);
    if (t) return t;
  }

  return "";
}

function trimText(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap - 1) + "…";
}

/**
 * Build a stable CSS selector path for the element. Used for
 * server-side dedup ("clicked the same button on the same page")
 * and for replay / heatmap reconstruction. Walks up to the body or
 * an element with an id, whichever comes first. Caps the depth at
 * 5 to keep selectors short and human-readable.
 */
function buildSelector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.nodeName.toLowerCase() !== "body" && depth < 5) {
    let part = cur.nodeName.toLowerCase();
    if (cur.id) {
      parts.unshift(`${part}#${cur.id}`);
      break; // ID is unique-enough — stop walking up
    }
    if (cur.classList.length > 0) {
      const cls = Array.from(cur.classList)
        .filter((c) => !c.startsWith("cd-")) // skip our own marker classes
        .slice(0, 2)
        .join(".");
      if (cls) part += `.${cls}`;
    }
    parts.unshift(part);
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

function collectDataAttrs(el: Element): Record<string, string> {
  // Pull every data-* attribute off the element. Devs use these
  // for explicit tagging — `data-cd-prop-plan="pro"` becomes a
  // property on the event so you can filter conversions by plan.
  const out: Record<string, string> = {};
  if (!(el instanceof HTMLElement)) return out;
  for (const name of el.getAttributeNames()) {
    if (!name.startsWith("data-")) continue;
    if (name === "data-cd-noTrack" || name === "data-cd-no-track") continue;
    if (name === "data-cd-event") continue; // used as event name, not prop
    const value = el.getAttribute(name) || "";
    // Normalise data-cd-prop-plan → "plan" key on properties
    const key = name.replace(/^data-cd-prop-/, "").replace(/^data-/, "");
    out[key] = value;
  }
  return out;
}

/**
 * Browser detection identical to device-info.ts isBrowser. Inlined here
 * so this module has zero internal imports — easier to tree-shake
 * out of Node-only consumers, and the function body is trivial.
 */
function isBrowserSafe(): boolean {
  return (
    typeof (globalThis as { window?: unknown }).window !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

function mintSessionId(): string {
  // Inline the same shape used elsewhere — `<prefix>_<base32-ts><10-char-rand>`.
  const ts = Date.now().toString(36);
  return `sess_${ts}${randomChars(10)}`;
}

/**
 * Read first-touch acquisition signals off the current page. Captures:
 *   - utm_source, utm_medium, utm_campaign, utm_content, utm_term
 *     (the standard Google Analytics campaign params)
 *   - referrer (full URL — backend extracts hostname for grouping)
 *
 * Returns empty strings outside a browser, before navigation, or when
 * the page has none of these signals. Never throws — a malformed URL
 * or an iframe with no document.referrer falls through to empty.
 *
 * Pure function. Exported for unit testing acquisition extraction.
 */
export function captureAcquisition(): SessionAcquisition {
  if (!isBrowserSafe()) return { ...EMPTY_ACQUISITION };

  const result: SessionAcquisition = { ...EMPTY_ACQUISITION };

  try {
    const w = (globalThis as { window: Window }).window;
    const params = new URLSearchParams(w.location.search ?? "");
    result.utm_source = params.get("utm_source") ?? "";
    result.utm_medium = params.get("utm_medium") ?? "";
    result.utm_campaign = params.get("utm_campaign") ?? "";
    result.utm_content = params.get("utm_content") ?? "";
    result.utm_term = params.get("utm_term") ?? "";
    // Paid-traffic click IDs — captured alongside UTMs because many
    // ad platforms (Performance Max, automated bidding) ship ONLY
    // a click-id, no utm_*.
    result.gclid = params.get("gclid") ?? "";
    result.fbclid = params.get("fbclid") ?? "";
    result.msclkid = params.get("msclkid") ?? "";
    result.ttclid = params.get("ttclid") ?? "";
    result.li_fat_id = params.get("li_fat_id") ?? "";
    result.twclid = params.get("twclid") ?? "";
  } catch {
    // window.location can throw in sandboxed iframes / data: URLs
  }

  try {
    const doc = (globalThis as { document: Document }).document;
    if (typeof doc.referrer === "string") result.referrer = doc.referrer;
  } catch {
    // document.referrer is well-supported but defensive in case
  }

  return result;
}
