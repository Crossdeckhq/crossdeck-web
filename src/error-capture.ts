/**
 * Error capture — the third Crossdeck USP.
 *
 * Catches every error source the browser can hand us and ships them as
 * Crossdeck events. The pipeline reuses the analytics queue:
 *   - Same durable persistence (errors survive crashes / hard closes)
 *   - Same exponential backoff (a flapping server doesn't flood
 *     errors past the rate limit)
 *   - Same Idempotency-Key (duplicate batches dedup server-side)
 *   - Same consent gate (consent.errors)
 *   - Same PII scrub on properties before they leave
 *
 * Error sources captured (each toggleable):
 *   1. window.onerror — uncaught synchronous errors
 *   2. window.onunhandledrejection — unhandled promise rejections
 *   3. fetch() wrap — HTTP errors the app code didn't catch
 *   4. XMLHttpRequest wrap — same, for legacy XHR consumers
 *   5. Crossdeck.captureError(err) — manual API for try/catch blocks
 *   6. Crossdeck.captureMessage(msg) — non-error events you want to
 *      surface as issues (e.g. "we hit the soft-deprecated path")
 *
 * Defensive design rules:
 *   - The error handler must NEVER throw — if our own code crashes
 *     while reporting an error, we'd take down the host app's error
 *     handler too. Every callback is wrapped in try/swallow.
 *   - Recursion guard: a `_reporting` flag prevents the SDK from
 *     reporting its own errors recursively forever.
 *   - Rate limited per-fingerprint: max N reports per second to defend
 *     against runaway loops (e.g. an error in setInterval).
 *   - Browser-extension noise is filtered by default — those errors
 *     aren't the developer's fault and would otherwise drown the
 *     signal.
 */

import { parseStack, fingerprintError, type StackFrame } from "./stack-parser";
import type { BreadcrumbBuffer, Breadcrumb } from "./breadcrumbs";

export type ErrorLevel = "error" | "warning" | "info";

export interface CapturedError {
  /** When the error fired (epoch ms). */
  timestamp: number;
  /** error.unhandled, error.unhandledrejection, error.handled, error.message, error.http */
  kind:
    | "error.unhandled"
    | "error.unhandledrejection"
    | "error.handled"
    | "error.message"
    | "error.http";
  level: ErrorLevel;
  message: string;
  /** The error class name when we have it (TypeError, ReferenceError, etc.) */
  errorType: string | null;
  /** Parsed stack frames, empty when unavailable. */
  frames: StackFrame[];
  /** Raw stack string for fallback display. */
  rawStack: string | null;
  /** Origin URL when available (window.onerror's `source` arg). */
  filename: string | null;
  lineno: number | null;
  colno: number | null;
  /** djb2 hash of message + top frames — group identical errors. */
  fingerprint: string;
  /** Snapshot of the breadcrumb buffer at the moment the error fired. */
  breadcrumbs: Breadcrumb[];
  /** Free-form context attached via Crossdeck.setContext(). */
  context: Record<string, unknown>;
  /** Free-form tags attached via Crossdeck.setTag(). */
  tags: Record<string, string>;
  /** "TypeError: x is not a function" → "TypeError" + "x is not a function". */
  /** Whether the error happened during a fetch / XHR. */
  http?: {
    url: string;
    method: string;
    status: number;
    statusText?: string;
  };
}

export interface ErrorCaptureConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /** Catch window.onerror. Default true. */
  onError: boolean;
  /** Catch unhandledrejection. Default true. */
  onUnhandledRejection: boolean;
  /** Wrap fetch() to capture non-2xx responses. Default true. */
  wrapFetch: boolean;
  /** Wrap XMLHttpRequest. Default true. */
  wrapXhr: boolean;
  /** Capture console.error calls. Default false (noisy). */
  captureConsole: boolean;
  /**
   * Drop errors matching these substrings or regexes. Tested against
   * `message`. Default: a curated list of browser noise (ResizeObserver
   * loop, top-frame errors from extensions, etc.).
   */
  ignoreErrors: Array<string | RegExp>;
  /**
   * Only capture errors whose top in-app frame URL matches one of
   * these. Empty array means "no allowlist — capture everything".
   * Useful when you want to ignore third-party widget errors.
   */
  allowUrls: Array<string | RegExp>;
  /**
   * Drop errors whose top frame URL matches any of these.
   */
  denyUrls: Array<string | RegExp>;
  /**
   * Sample rate, 0–1. 1.0 = send every error. 0.5 = send half (per
   * fingerprint, deterministically — so a given user always either
   * sends a given error or never does). Default 1.0.
   */
  sampleRate: number;
  /**
   * Maximum errors per fingerprint per minute. Defends against runaway
   * loops. Default 5.
   */
  maxPerFingerprintPerMinute: number;
  /**
   * Total cap per session, regardless of fingerprint. Hard limit
   * after which we stop reporting until the next session. Default 100.
   */
  maxPerSession: number;
}

export const DEFAULT_ERROR_CAPTURE: ErrorCaptureConfig = {
  enabled: true,
  onError: true,
  onUnhandledRejection: true,
  wrapFetch: true,
  wrapXhr: true,
  captureConsole: false,
  ignoreErrors: [
    // Classic browser noise. These aren't application bugs.
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications",
    "Non-Error promise rejection captured",
    // NOTE: We deliberately do NOT drop cross-origin "Script error."
    // events here. The actionability principle (see denyUrls
    // comment below) draws the line at "developer cannot act":
    // cross-origin CORS opacity HAS a real, code-shaped fix (add
    // `crossorigin="anonymous"` to the script tag + CORS headers
    // on the script's origin). The dashboard surfaces these with a
    // `cross_origin` tag pointing at that fix. Apps that genuinely
    // want them muted can re-add "Script error" to ignoreErrors
    // via init config.
  ],
  allowUrls: [],
  denyUrls: [
    // The actionability principle
    // ---------------------------
    // Crossdeck's default philosophy is "classify, don't silently
    // drop" — surfacing errors the developer can fix is more useful
    // than hiding them. That's right for cross-origin "Script
    // error." (real, code-shaped CORS fix) and for plain
    // application bugs (obviously real).
    //
    // It's NOT right for events the developer cannot act on.
    //   - A user's installed browser extension throwing inside
    //     its own `chrome-extension://` URL: the developer can't
    //     ship a fix for someone else's extension.
    //   - An ad blocker preventing `googletagmanager.com` from
    //     loading: the developer can't unblock the user's blocker.
    //
    // Capturing these creates a noise tab that's always non-empty
    // and never actionable, which trains the dev to ignore the
    // noise tab — and then the actionable noise (CORS opacity,
    // etc.) gets ignored along with it. Same lesson as Crossdeck's
    // "0-2 notifications a week" discipline: a signal that fires
    // constantly with nothing actionable behind it stops being a
    // signal.
    //
    // So we drop at the source for the unactionable category, and
    // keep capturing for the actionable category. Same principle
    // applied to two structurally different inputs — not a new
    // philosophy.
    //
    // The bootstrap list below is the minimum that ships in code.
    // The full, versioned list arrives at boot via /v1/config —
    // see `backend/src/lib/error-noise-deny-list.ts`. The SDK
    // applies the union of (bootstrap + remote), so a freshly-
    // installed SDK protects users immediately, and remote updates
    // (new ad-network domains, new pixel hosts) reach every
    // install without an SDK release.
    //
    // The backend Layer-2 classifier
    // (`backend/src/api/lib/noise-classifier.ts`) is the safety
    // net for events that slip past these patterns — older SDK
    // versions in the wild that haven't fetched the remote list
    // yet, or brand-new patterns the list hasn't named.
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    /^safari-extension:\/\//,
    /^webkit-extension:\/\//,
    /^safari-web-extension:\/\//,
  ],
  sampleRate: 1.0,
  maxPerFingerprintPerMinute: 5,
  maxPerSession: 100,
};

export interface ErrorTrackerOptions {
  config: ErrorCaptureConfig;
  breadcrumbs: BreadcrumbBuffer;
  /** Called with each captured error. Forwards into the event queue. */
  report: (err: CapturedError) => void;
  /** Called to read the current developer-supplied context bag. */
  getContext: () => Record<string, unknown>;
  /** Called to read the current developer-supplied tag bag. */
  getTags: () => Record<string, string>;
  /**
   * Pre-send hook GETTER. The tracker invokes this on EVERY captured
   * error to resolve the current hook reference, then calls the
   * resolved function with the error (returning `null` to drop, or a
   * modified `CapturedError` to forward).
   *
   * It's a getter — not a static function — so `setErrorBeforeSend()`
   * can install or replace the hook after init() without re-creating
   * the tracker. Pre-fix this was a captured value: the tracker took
   * a snapshot of `null` at construction time and never re-read state,
   * so every customer's PII scrubber installed later was silently inert.
   * Bank-grade rule: a hook the customer can call into MUST take effect
   * the instant it's installed.
   *
   * Returning `null` from the GETTER means "no hook configured" and
   * the report goes through unmodified — distinct from returning a
   * function-that-returns-null (which means "drop this specific report").
   */
  beforeSend?: () => ((err: CapturedError) => CapturedError | null) | null;
  /**
   * Whether the consent dimension `errors` is currently granted.
   * Checked at capture time so a flip via Crossdeck.consent() takes
   * effect immediately.
   */
  isConsented: () => boolean;
  /**
   * The SDK's own backend hostname (derived from
   * `CrossdeckOptions.baseUrl` at construction time). Used to skip
   * captureHttp for our own requests — otherwise an outage on the
   * Crossdeck backend would trigger captureHttp → enqueue →
   * `POST /events` → fail again → captureHttp → ∞ until the queue
   * gives up on a permanent 4xx (Batch B fix) or runs forever on a
   * 5xx. Pre-fix the skip pattern was hardcoded to
   * `api.cross-deck.com`, which failed customers using staging /
   * regional / self-hosted-relay base URLs. Audit punch list P0 #7.
   *
   * Null / omitted when extraction from baseUrl fails (malformed URL)
   * OR when the test harness doesn't supply one — the tracker falls
   * through to "capture everything" rather than swallow.
   */
  selfHostname?: string | null;
}

export class ErrorTracker {
  private installed = false;
  private cleanups: Array<() => void> = [];
  private _reporting = false;
  private sessionCount = 0;
  private fingerprintWindow = new Map<string, number[]>();

  constructor(private readonly opts: ErrorTrackerOptions) {}

  install(): void {
    if (this.installed) return;
    if (!this.opts.config.enabled) return;
    if (typeof globalThis === "undefined" || !("window" in globalThis)) return;

    const w = (globalThis as { window: Window }).window;

    if (this.opts.config.onError) this.installOnErrorListener(w);
    if (this.opts.config.onUnhandledRejection) this.installRejectionListener(w);
    if (this.opts.config.wrapFetch) this.installFetchWrap(w);
    if (this.opts.config.wrapXhr) this.installXhrWrap(w);
    if (this.opts.config.captureConsole) this.installConsoleWrap();

    this.installed = true;
  }

  uninstall(): void {
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    this.installed = false;
  }

  /**
   * Manual API. Either an Error instance or any unknown value (we
   * coerce). Returns silently — never throws.
   */
  captureError(
    error: unknown,
    options?: { context?: Record<string, unknown>; tags?: Record<string, string>; level?: ErrorLevel },
  ): void {
    if (!this.opts.isConsented()) return;
    try {
      const captured = this.buildFromUnknown(error, "error.handled", options?.level ?? "error");
      if (options?.context) captured.context = { ...captured.context, ...options.context };
      if (options?.tags) captured.tags = { ...captured.tags, ...options.tags };
      this.maybeReport(captured);
    } catch {
      // self-protection — never let our own code crash the caller's
      // error handler.
    }
  }

  /**
   * Capture a non-error event as an issue. For "we hit a soft-warning
   * code path" / "deprecated API used" kinds of signals. Pairs with
   * Sentry's captureMessage().
   */
  captureMessage(message: string, level: ErrorLevel = "info"): void {
    if (!this.opts.isConsented()) return;
    try {
      const captured: CapturedError = {
        timestamp: Date.now(),
        kind: "error.message",
        level,
        message,
        errorType: null,
        frames: [],
        rawStack: null,
        filename: null,
        lineno: null,
        colno: null,
        fingerprint: fingerprintError(message, []),
        breadcrumbs: this.opts.breadcrumbs.snapshot(),
        context: this.opts.getContext(),
        tags: this.opts.getTags(),
      };
      this.maybeReport(captured);
    } catch {
      // swallow
    }
  }

  // ============================================================
  // Listener installation
  // ============================================================

  private installOnErrorListener(w: Window): void {
    const handler = (event: ErrorEvent): void => {
      if (this._reporting) return;
      if (!this.opts.isConsented()) return;
      try {
        this._reporting = true;
        const captured = this.buildFromErrorEvent(event);
        this.maybeReport(captured);
      } catch {
        // swallow
      } finally {
        this._reporting = false;
      }
    };
    w.addEventListener("error", handler, true);
    this.cleanups.push(() => w.removeEventListener("error", handler, true));
  }

  private installRejectionListener(w: Window): void {
    const handler = (event: PromiseRejectionEvent): void => {
      if (this._reporting) return;
      if (!this.opts.isConsented()) return;
      try {
        this._reporting = true;
        const captured = this.buildFromUnknown(
          event.reason,
          "error.unhandledrejection",
          "error",
        );
        this.maybeReport(captured);
      } catch {
        // swallow
      } finally {
        this._reporting = false;
      }
    };
    w.addEventListener("unhandledrejection", handler);
    this.cleanups.push(() => w.removeEventListener("unhandledrejection", handler));
  }

  /**
   * Wrap fetch() so failed HTTP requests get auto-captured. We do NOT
   * call this an "error" for 4xx (those are often expected — auth
   * required, validation failed). Only 5xx + network failures fire.
   */
  private installFetchWrap(w: Window): void {
    const origFetch = w.fetch?.bind(w);
    if (!origFetch) return;
    const wrapped = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const input = args[0];
      const init = args[1] ?? {};
      const url = typeof input === "string" ? input : (input as Request)?.url ?? "";
      const method = (init.method || "GET").toUpperCase();
      const start = Date.now();

      // Breadcrumb for the request itself — fires regardless of outcome.
      // Skip self-requests: an error report's breadcrumb trail showing
      // "POST https://api.cross-deck.com/v1/events" entries is noise the
      // engineer reading the error doesn't care about (the SDK itself
      // emitted them, not the user code under inspection). Same predicate
      // as captureHttp's self-skip. Audit P2 polish.
      if (!isSelfRequest(url, this.opts.selfHostname)) {
        this.opts.breadcrumbs.add({
          timestamp: start,
          category: "http",
          message: `${method} ${url}`,
          data: { url, method },
        });
      }

      try {
        const response = await origFetch(...args);
        if (response.status >= 500 && this.opts.isConsented()) {
          // Self-skip Crossdeck's own API to avoid reporting our own
          // backend errors back to ourselves (cycle hazard if the
          // outage is on our side).
          if (!isSelfRequest(url, this.opts.selfHostname)) {
            this.captureHttp({
              url,
              method,
              status: response.status,
              statusText: response.statusText,
            });
          }
        }
        return response;
      } catch (err) {
        // Genuine network failure (DNS, connection refused, CORS).
        if (this.opts.isConsented() && !url.includes("api.cross-deck.com")) {
          this.captureHttp({
            url,
            method,
            status: 0,
            statusText: err instanceof Error ? err.message : "network error",
          });
        }
        throw err;
      }
    };
    w.fetch = wrapped as typeof fetch;
    this.cleanups.push(() => {
      // Restore only if we're still the active wrapper.
      if (w.fetch === wrapped) w.fetch = origFetch;
    });
  }

  /**
   * Wrap XMLHttpRequest for legacy consumers (jQuery $.ajax under the
   * hood, older bundlers). Same capture semantics as fetch.
   */
  private installXhrWrap(w: Window): void {
    const xhrCtor = (w as Window & { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
    const proto = xhrCtor?.prototype;
    if (!proto) return;
    const origOpen = proto.open;
    const origSend = proto.send;

    const tracker = this;
    proto.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]): void {
      (this as XMLHttpRequest & { _cdMethod?: string; _cdUrl?: string })._cdMethod = method;
      (this as XMLHttpRequest & { _cdMethod?: string; _cdUrl?: string })._cdUrl = url;
      // Cast args to match the lib signature.
      return origOpen.apply(this, [method, url, ...(rest as [boolean, string?, string?])]);
    };
    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      const xhr = this as XMLHttpRequest & { _cdMethod?: string; _cdUrl?: string };
      const onLoad = (): void => {
        try {
          if (xhr.status >= 500 && tracker.opts.isConsented()) {
            const url = xhr._cdUrl ?? "";
            if (!isSelfRequest(url, tracker.opts.selfHostname)) {
              tracker.captureHttp({
                url,
                method: (xhr._cdMethod ?? "GET").toUpperCase(),
                status: xhr.status,
                statusText: xhr.statusText,
              });
            }
          }
        } catch {
          // swallow
        }
      };
      xhr.addEventListener("loadend", onLoad);
      return origSend.apply(this, [body ?? null]);
    };

    this.cleanups.push(() => {
      proto.open = origOpen;
      proto.send = origSend;
    });
  }

  private installConsoleWrap(): void {
    const console = (globalThis as { console?: Console }).console;
    if (!console) return;
    const orig = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      try {
        if (this.opts.isConsented()) {
          this.captureMessage(args.map((a) => safeStringify(a)).join(" "), "error");
        }
      } catch {
        // swallow
      }
      return orig(...args);
    };
    this.cleanups.push(() => {
      console.error = orig;
    });
  }

  // ============================================================
  // Builders
  // ============================================================

  private buildFromErrorEvent(event: ErrorEvent): CapturedError {
    const err = event.error;
    const filename = event.filename || null;
    const lineno = typeof event.lineno === "number" && event.lineno > 0 ? event.lineno : null;
    const colno = typeof event.colno === "number" && event.colno > 0 ? event.colno : null;

    // ── Cross-origin script error path ────────────────────────────────
    // Signature: browser hands us "Script error." (or empty), null
    // error object, and no usable location. We can't recover the real
    // message — but instead of stashing a useless "Unknown error",
    // we label the event clearly and tag it so the dashboard groups
    // it as a distinct, actionable category with a known remediation
    // (add crossorigin="anonymous" + CORS headers on the script's
    // origin).
    const isCrossOriginStripped =
      err == null &&
      !filename &&
      lineno == null &&
      (event.message === "Script error." ||
        event.message === "Script error" ||
        !event.message);
    if (isCrossOriginStripped) {
      const message =
        "Cross-origin script error (browser hid details — script needs crossorigin attribute + CORS headers)";
      return {
        timestamp: Date.now(),
        kind: "error.unhandled",
        level: "error",
        message,
        errorType: "ScriptError",
        frames: [],
        rawStack: null,
        filename: null,
        lineno: null,
        colno: null,
        // No location to fingerprint by — all of these will share one
        // group, which is correct: developer fixes them all with the
        // same CORS change.
        fingerprint: fingerprintError(message, []),
        breadcrumbs: this.opts.breadcrumbs.snapshot(),
        context: this.opts.getContext(),
        tags: { ...this.opts.getTags(), cross_origin: "true" },
      };
    }

    // ── Normal path ───────────────────────────────────────────────────
    // Pull every drop of signal out of the raw `event.error`, then fall
    // back to `event.message` if the value didn't yield one of its own.
    const payload = coerceErrorPayload(err);
    const message = (
      payload.message ||
      event.message ||
      "Unknown error"
    ).slice(0, 1024);
    const stack = err instanceof Error ? err.stack ?? null : null;
    const frames = parseStack(stack);
    const errorType = payload.errorType ?? null;

    const context = payload.extras
      ? { ...this.opts.getContext(), __error_extras: payload.extras }
      : this.opts.getContext();

    return {
      timestamp: Date.now(),
      kind: "error.unhandled",
      level: "error",
      message,
      errorType,
      frames,
      rawStack: stack,
      filename,
      lineno,
      colno,
      // Location fallback ensures distinct call sites stay separate
      // even when the message is generic ("Unknown error",
      // "[object Object]") and there are no parseable frames.
      fingerprint: fingerprintError(message, frames, {
        filename,
        lineno,
        colno,
        errorType,
      }),
      breadcrumbs: this.opts.breadcrumbs.snapshot(),
      context,
      tags: this.opts.getTags(),
    };
  }

  private buildFromUnknown(
    err: unknown,
    kind: CapturedError["kind"],
    level: ErrorLevel,
  ): CapturedError {
    const payload = coerceErrorPayload(err);
    const message = (payload.message || "Unknown error").slice(0, 1024);
    const stack = err instanceof Error ? err.stack ?? null : null;
    const frames = parseStack(stack);
    const errorType = payload.errorType ?? null;

    const context = payload.extras
      ? { ...this.opts.getContext(), __error_extras: payload.extras }
      : this.opts.getContext();

    return {
      timestamp: Date.now(),
      kind,
      level,
      message,
      errorType,
      frames,
      rawStack: stack,
      filename: null,
      lineno: null,
      colno: null,
      fingerprint: fingerprintError(message, frames, { errorType }),
      breadcrumbs: this.opts.breadcrumbs.snapshot(),
      context,
      tags: this.opts.getTags(),
    };
  }

  private captureHttp(info: {
    url: string;
    method: string;
    status: number;
    statusText?: string;
  }): void {
    try {
      const message = `HTTP ${info.status} ${info.method} ${info.url}`;
      const captured: CapturedError = {
        timestamp: Date.now(),
        kind: "error.http",
        level: "error",
        message,
        errorType: `HTTPError`,
        frames: [],
        rawStack: null,
        filename: info.url,
        lineno: null,
        colno: null,
        fingerprint: fingerprintError(`HTTP ${info.status} ${info.method}`, [], {
          filename: info.url,
          errorType: "HTTPError",
        }),
        breadcrumbs: this.opts.breadcrumbs.snapshot(),
        context: this.opts.getContext(),
        tags: this.opts.getTags(),
        http: info,
      };
      this.maybeReport(captured);
    } catch {
      // swallow
    }
  }

  // ============================================================
  // Reporting pipeline — filter / sample / rate-limit / send
  // ============================================================

  private maybeReport(err: CapturedError): void {
    if (this.sessionCount >= this.opts.config.maxPerSession) return;
    if (this.shouldIgnore(err)) return;
    if (!this.passesUrlGate(err)) return;
    if (!this.passesSample(err)) return;
    if (!this.passesRateLimit(err)) return;

    // beforeSend hook — last chance to scrub or drop. Resolve the
    // current hook through the getter on every call so a hook installed
    // via `setErrorBeforeSend()` AFTER init() takes effect on THIS
    // error, not just future ones constructed by a future tracker.
    let finalErr: CapturedError | null = err;
    const hook = this.opts.beforeSend?.();
    if (hook) {
      try {
        finalErr = hook(err);
      } catch {
        // A buggy beforeSend hook must NOT swallow the error report.
        // Fall back to the original.
        finalErr = err;
      }
      if (!finalErr) return;
    }

    this.sessionCount += 1;
    try {
      this.opts.report(finalErr);
    } catch {
      // swallow — report() failure is best-effort; the next error
      // attempt will retry through the same queue.
    }
  }

  private shouldIgnore(err: CapturedError): boolean {
    for (const pat of this.opts.config.ignoreErrors) {
      if (typeof pat === "string" && err.message.includes(pat)) return true;
      if (pat instanceof RegExp && pat.test(err.message)) return true;
    }
    return false;
  }

  private passesUrlGate(err: CapturedError): boolean {
    const topFrame = err.frames.find((f) => f.filename) ?? null;
    const url = topFrame?.filename ?? err.filename ?? "";
    if (!url) return true; // unknown URL — let it through

    for (const pat of this.opts.config.denyUrls) {
      if (typeof pat === "string" && url.includes(pat)) return false;
      if (pat instanceof RegExp && pat.test(url)) return false;
    }
    if (this.opts.config.allowUrls.length > 0) {
      for (const pat of this.opts.config.allowUrls) {
        if (typeof pat === "string" && url.includes(pat)) return true;
        if (pat instanceof RegExp && pat.test(url)) return true;
      }
      return false;
    }
    return true;
  }

  private passesSample(err: CapturedError): boolean {
    if (this.opts.config.sampleRate >= 1) return true;
    if (this.opts.config.sampleRate <= 0) return false;
    // Deterministic per-fingerprint sampling — a given user always
    // either always sends a given error or never does, no flapping.
    const hashByte = parseInt(err.fingerprint.slice(0, 2), 16);
    return (hashByte / 255) < this.opts.config.sampleRate;
  }

  private passesRateLimit(err: CapturedError): boolean {
    const windowMs = 60_000;
    const now = Date.now();
    const max = this.opts.config.maxPerFingerprintPerMinute;
    const arr = this.fingerprintWindow.get(err.fingerprint) ?? [];
    // Drop entries older than the window.
    const fresh = arr.filter((t) => now - t < windowMs);
    if (fresh.length >= max) {
      this.fingerprintWindow.set(err.fingerprint, fresh);
      return false;
    }
    fresh.push(now);
    this.fingerprintWindow.set(err.fingerprint, fresh);
    return true;
  }
}

/**
 * The thrown-value coercer.
 *
 * The browser's error pipelines (window.onerror, unhandledrejection,
 * developer `throw`) hand us values of every shape — Error instances,
 * DOMExceptions, plain objects, primitives, even null. Earlier
 * versions of this code wrote "Unknown error" whenever the value
 * wasn't an Error with a non-empty `.message`, which silently
 * collapsed entire classes of real bugs into one unhelpful bucket.
 *
 * This function extracts the maximum information available without
 * ever throwing (Symbol keys, recursive proxies, throwing toString —
 * all defended against). It returns three pieces:
 *
 *   - message:   the human-readable headline, never empty for any
 *                non-null/non-undefined input
 *   - errorType: the constructor name when we can discover one
 *                (Error subclass, DOMException, custom class) —
 *                feeds the dashboard's "type · message" header
 *   - extras:    additional fields worth keeping (Error.cause chain,
 *                .code/.status/.response on common patterns, any
 *                enumerable own properties on an Error subclass).
 *                Stashed on context.__error_extras for the
 *                dashboard's "raw event" panel.
 */
interface CoercedPayload {
  message: string;
  errorType: string | null;
  extras: Record<string, unknown> | null;
}

function coerceErrorPayload(v: unknown): CoercedPayload {
  if (v === null) return { message: "(thrown: null)", errorType: null, extras: null };
  if (v === undefined) return { message: "(thrown: undefined)", errorType: null, extras: null };

  if (typeof v === "string") {
    return { message: v, errorType: null, extras: null };
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return { message: String(v), errorType: typeof v, extras: null };
  }
  if (typeof v === "symbol") {
    return { message: v.toString(), errorType: "symbol", extras: null };
  }
  if (typeof v === "function") {
    return { message: `(thrown function: ${v.name || "anonymous"})`, errorType: "function", extras: null };
  }

  // Object-ish from here on — Error, DOMException, Response, plain
  // objects, custom classes, etc.
  if (v instanceof Error) {
    const errorType =
      v.name || v.constructor?.name || "Error";
    const message =
      typeof v.message === "string" && v.message.length > 0
        ? v.message
        : safeToString(v) || errorType;

    const extras: Record<string, unknown> = {};

    // ES2022 Error.cause — walk up to 5 levels so a service-layer
    // wrapper error doesn't hide the underlying network failure.
    const causeChain = collectCauseChain(v);
    if (causeChain.length > 0) extras.cause = causeChain;

    // Common HTTP/RPC patterns attach status/code/response to thrown
    // values. Capture them without forcing every wrapper class to
    // override toString.
    for (const key of ["code", "status", "statusCode", "errno", "response", "data", "detail", "details"] as const) {
      const val = (v as unknown as Record<string, unknown>)[key];
      if (val !== undefined && typeof val !== "function") {
        extras[key] = safeClone(val);
      }
    }

    // Any other enumerable own properties (custom Error subclasses
    // that add fields).
    for (const key of Object.keys(v)) {
      if (key === "message" || key === "stack" || key === "name" || key === "cause") continue;
      if (key in extras) continue;
      const val = (v as unknown as Record<string, unknown>)[key];
      if (typeof val === "function") continue;
      extras[key] = safeClone(val);
    }

    return {
      message,
      errorType,
      extras: Object.keys(extras).length > 0 ? extras : null,
    };
  }

  // Response — fetch().then(r => { if (!r.ok) throw r }) is a common
  // pattern, and the bare Response is otherwise unreadable.
  if (typeof Response !== "undefined" && v instanceof Response) {
    return {
      message: `HTTP ${v.status} ${v.statusText || ""}${v.url ? ` ${v.url}` : ""}`.trim(),
      errorType: "Response",
      extras: { status: v.status, statusText: v.statusText, url: v.url, type: v.type },
    };
  }

  // DOMException, Event, anything with a useful native toString —
  // capture the constructor name as the type, then prefer the
  // object's .message field if it has one (DOMException does;
  // ErrorEvent does; many polyfills do).
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const ctorName =
      (obj.constructor && typeof obj.constructor === "function" && (obj.constructor as { name?: string }).name) ||
      null;

    const ownMessage = typeof obj.message === "string" && obj.message ? obj.message : null;
    const ownName = typeof obj.name === "string" && obj.name ? obj.name : null;

    let jsonForm: string | null = null;
    try {
      const serialised = JSON.stringify(obj);
      // JSON.stringify of an empty object is "{}", which is useless
      // as a message but tells us we have a thrown object with no
      // enumerable own props.
      jsonForm = serialised === "{}" ? null : serialised;
    } catch {
      jsonForm = null;
    }

    const fallbackString = safeToString(obj);
    const message =
      ownMessage ??
      jsonForm ??
      (fallbackString && fallbackString !== "[object Object]" ? fallbackString : null) ??
      (ctorName ? `(thrown ${ctorName} with no message)` : "(thrown object with no message)");

    const errorType = ownName ?? ctorName ?? null;

    // Best-effort extras for objects: keep up to ~20 enumerable own
    // properties, JSON-safe.
    const extras: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(obj)) {
      if (count >= 20) break;
      if (key === "message" || key === "name") continue;
      const val = obj[key];
      if (typeof val === "function") continue;
      extras[key] = safeClone(val);
      count++;
    }

    return {
      message,
      errorType,
      extras: Object.keys(extras).length > 0 ? extras : null,
    };
  }

  // Should be unreachable, but: fall back to coerced string.
  return { message: safeToString(v) || "(unstringifiable thrown value)", errorType: null, extras: null };
}

function collectCauseChain(err: Error): Array<{ name: string; message: string }> {
  const out: Array<{ name: string; message: string }> = [];
  let cur: unknown = (err as Error & { cause?: unknown }).cause;
  let depth = 0;
  while (cur != null && depth < 5) {
    if (cur instanceof Error) {
      out.push({ name: cur.name || "Error", message: cur.message || "" });
      cur = (cur as Error & { cause?: unknown }).cause;
    } else {
      out.push({ name: "non-Error", message: safeToString(cur) });
      cur = null;
    }
    depth++;
  }
  return out;
}

function safeToString(v: unknown): string {
  try {
    const s = Object.prototype.toString.call(v);
    if (s !== "[object Object]") return s;
    // Try the value's own toString if it overrides Object's default.
    const own = (v as { toString?: () => unknown })?.toString;
    if (typeof own === "function" && own !== Object.prototype.toString) {
      const r = own.call(v);
      if (typeof r === "string") return r;
    }
    return s;
  } catch {
    return "(throwing toString)";
  }
}

function safeClone(v: unknown): unknown {
  if (v == null) return v;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "bigint") return String(v);
  try {
    // JSON.stringify will throw on circular structures; that's fine,
    // we fall back to the toString below.
    const s = JSON.stringify(v);
    return s === undefined ? safeToString(v) : JSON.parse(s);
  } catch {
    return safeToString(v);
  }
}

function safeStringify(v: unknown): string {
  return coerceErrorPayload(v).message;
}

/**
 * Extract the hostname from a URL string for use as the
 * `selfHostname` field on the ErrorTracker. Returns null on malformed
 * input — the tracker's downstream self-skip check treats `null` as
 * "no self to skip" and captures everything (safer than swallowing
 * legitimate errors on a config typo).
 *
 * Lowercased for case-insensitive comparison (`Api.Cross-Deck.com`
 * and `api.cross-deck.com` are the same host).
 */
export function extractSelfHostname(baseUrl: string | undefined | null): string | null {
  if (!baseUrl || typeof baseUrl !== "string") return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the request URL targets the SDK's own backend hostname.
 * Used by the fetch / XHR wrappers to skip captureHttp on Crossdeck's
 * own requests — otherwise a Crossdeck-side outage would recurse
 * (captureHttp → enqueue → /events → fail → captureHttp → …).
 *
 * Strict hostname compare (not substring) so a path like
 * `https://api.cross-deck.com.attacker.example/...` doesn't falsely
 * match `api.cross-deck.com`. Falls back to `false` on malformed URLs
 * — the SDK only ever uses absolute URLs, so a relative URL can't
 * be the SDK's own request.
 */
export function isSelfRequest(requestUrl: string, selfHostname: string | null | undefined): boolean {
  if (!selfHostname || !requestUrl) return false;
  try {
    return new URL(requestUrl).hostname.toLowerCase() === selfHostname;
  } catch {
    return false;
  }
}
