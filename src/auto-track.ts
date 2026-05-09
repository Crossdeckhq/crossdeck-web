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
}

export const DEFAULT_AUTO_TRACK: AutoTrackConfig = {
  sessions: true,
  pageViews: true,
  deviceInfo: true,
};

/** Reopen as a new session if the tab was hidden longer than this. */
const SESSION_RESUME_THRESHOLD_MS = 30 * 60 * 1000;

type TrackFn = (name: string, properties?: Record<string, unknown>) => void;

interface SessionState {
  sessionId: string;
  startedAt: number;
  hiddenAt: number | null;
  endedSent: boolean;
}

export class AutoTracker {
  private session: SessionState | null = null;
  private cleanups: Array<() => void> = [];

  constructor(
    private readonly cfg: AutoTrackConfig,
    private readonly track: TrackFn,
  ) {}

  install(): void {
    if (!isBrowserSafe()) return;
    if (this.cfg.sessions) this.installSessionTracking();
    if (this.cfg.pageViews) this.installPageViewTracking();
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

    const fire = (): void => {
      const loc = w.location;
      this.track("page.viewed", {
        path: loc.pathname,
        url: loc.href,
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

    const onPopState = (): void => fire();
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
