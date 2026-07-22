/**
 * Stack-trace parser — normalises Chrome / Firefox / Safari / Edge
 * stack strings into a common frame shape.
 *
 * Why hand-rolled, not stack-trace-js or error-stack-parser libraries:
 * those weigh 5–15 KB after minification and we'd be pulling in their
 * full feature matrix just for the parser. The patterns below cover
 * the four shapes any modern browser emits, totalling ~80 lines.
 *
 * The output frame shape mirrors what Sentry's `mechanism: { type:
 * 'generic' }` events ship, so future source-map symbolication on the
 * Crossdeck backend has a stable input to work against.
 *
 * Defensive: never throws. An unparseable line becomes a `raw` frame
 * with just the literal text. Engineers reading errors still get the
 * raw stack as fallback.
 */

export interface StackFrame {
  /** Function name, or "?" if anonymous / unparseable. */
  function: string;
  /** Source file URL the frame ran in. Empty when unknown. */
  filename: string;
  /** 1-indexed line number, or 0 when unknown. */
  lineno: number;
  /** 1-indexed column number, or 0 when unknown. */
  colno: number;
  /**
   * True when the frame is in the app's own code (best-effort:
   * detected by URL not starting with chrome-extension://, etc.).
   * Helps the dashboard's "your code vs library code" view.
   */
  in_app: boolean;
  /** Raw line from the stack string for debugging when parse fails. */
  raw: string;
}

/**
 * Parse a stack string into an array of frames. Returns an empty
 * array when the input is unparseable — caller should always treat
 * the original `error.stack` as the source of truth for display.
 */
export function parseStack(stack: string | undefined | null): StackFrame[] {
  if (!stack || typeof stack !== "string") return [];
  const lines = stack.split("\n");
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const frame = parseLine(trimmed);
    if (frame) frames.push(frame);
  }
  return frames;
}

/**
 * Parse a single stack line. Returns null for header lines like
 * "TypeError: x is not a function" (those carry no frame info).
 *
 * Patterns recognised:
 *   Chrome:  "at functionName (file:line:col)"
 *   Chrome:  "at file:line:col"
 *   Firefox: "functionName@file:line:col"
 *   Safari:  "functionName@file:line:col"  (same as Firefox)
 *   Node:    "at functionName (file:line:col)"  (Chrome-shaped)
 */
function parseLine(line: string): StackFrame | null {
  // Chrome / Node V8 — with parens
  // Example:  at Object.handleClick (https://app.com/app.js:42:18)
  let m = /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/.exec(line);
  if (m) {
    return buildFrame({
      function: m[1]!,
      filename: m[2]!,
      lineno: parseInt(m[3]!, 10),
      colno: parseInt(m[4]!, 10),
      raw: line,
    });
  }

  // Chrome / Node V8 — anonymous, no parens
  // Example:  at https://app.com/app.js:42:18
  m = /^at\s+(.+?):(\d+):(\d+)$/.exec(line);
  if (m) {
    return buildFrame({
      function: "?",
      filename: m[1]!,
      lineno: parseInt(m[2]!, 10),
      colno: parseInt(m[3]!, 10),
      raw: line,
    });
  }

  // Firefox / Safari
  // Example:  handleClick@https://app.com/app.js:42:18
  m = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line);
  if (m) {
    return buildFrame({
      function: m[1]! || "?",
      filename: m[2]!,
      lineno: parseInt(m[3]!, 10),
      colno: parseInt(m[4]!, 10),
      raw: line,
    });
  }

  // Header line (e.g. "TypeError: foo is not a function") — return null
  // so caller skips it.
  if (/^\w*Error/.test(line) || !line.includes(":")) {
    return null;
  }

  // Unparseable but plausibly a frame — keep it as raw.
  return {
    function: "?",
    filename: "",
    lineno: 0,
    colno: 0,
    in_app: true,
    raw: line,
  };
}

function buildFrame(input: {
  function: string;
  filename: string;
  lineno: number;
  colno: number;
  raw: string;
}): StackFrame {
  return {
    function: input.function || "?",
    filename: input.filename,
    lineno: Number.isFinite(input.lineno) ? input.lineno : 0,
    colno: Number.isFinite(input.colno) ? input.colno : 0,
    in_app: isInAppFrame(input.filename),
    raw: input.raw,
  };
}

/**
 * Best-effort "is this frame in the app's own code or a third-party
 * source we should de-emphasise in the UI".
 *
 * Out-of-app heuristics: browser extensions, well-known CDN URLs,
 * and the SDK's own bundle.
 */
function isInAppFrame(filename: string): boolean {
  if (!filename) return true;
  if (/^(?:chrome|moz|safari|webkit)-extension:\/\//.test(filename)) return false;
  // In-app-browser injected scripts — Meta's Instagram/Facebook Android WebView
  // (`iabjs://…navigation_performance_logger…`), TikTok, etc. This is vendor code
  // the host app injects into its own WebView; it is NOT the developer's app, and
  // marking it in_app falsely blames their code for the in-app browser's own errors.
  if (/^iabjs:\/\//.test(filename)) return false;
  if (/^(?:webview|inappbrowser):\/\//i.test(filename)) return false;
  if (/\bcdn\.jsdelivr\.net\b/.test(filename)) return false;
  if (/\bunpkg\.com\b/.test(filename)) return false;
  if (/\bgoogletagmanager\.com\b/.test(filename)) return false;
  if (/\bgoogle-analytics\.com\b/.test(filename)) return false;
  if (/\b@cross-deck\/web\b/.test(filename)) return false;
  if (/\/crossdeck\.umd\.min\.js$/.test(filename)) return false;
  return true;
}

/**
 * Browser-private injected globals — objects a BROWSER (not the app) injects
 * into every page's global scope. Unlike the `iabjs://` in-app-browser scheme,
 * the injected content-script here throws in the PAGE's own scope, so the
 * throwing frame's filename is the customer's URL (`https://app.com/x:1:19`,
 * "global code") and looks in_app — even though the customer never wrote that
 * global. We can't tell from the filename; the tell is the global's name in the
 * MESSAGE. Curated allowlist (mirrors the Crossdeck backend classifier), NOT a
 * broad `/__\w+__/` that would swallow real app globals (`__NEXT_DATA__`).
 *   __firefox__  Firefox for iOS (reader-mode content script)
 *   __gCrWeb     Chrome for iOS / Google WebViews
 *   zaloJSV2     Zalo in-app browser
 */
const BROWSER_INJECTED_GLOBAL = /(__firefox__|__gCrWeb|zaloJSV2)/;

/**
 * The browser-private injected global named in the message, or null. E.g.
 * "undefined is not an object (evaluating 'window.__firefox__.reader')" and
 * "Can't find variable: __firefox__" both return "__firefox__".
 */
export function injectedGlobalName(message: string | undefined | null): string | null {
  const m = BROWSER_INJECTED_GLOBAL.exec(message ?? "");
  return m ? m[1]! : null;
}

/**
 * When the error is a browser-injected-global throw, force EVERY frame
 * `in_app: false` — the throw ran in the page's global scope but is the
 * browser's own vendor code, not the developer's. No-op otherwise. Returns a
 * new array only when it changes something.
 */
export function demoteVendorInjectedFrames(
  frames: StackFrame[],
  message: string | undefined | null,
): StackFrame[] {
  if (!injectedGlobalName(message)) return frames;
  return frames.map((f) => (f.in_app ? { ...f, in_app: false } : f));
}

/**
 * Fingerprint an error for grouping. SHA-flavoured — we don't need
 * cryptographic strength, we need "two errors with the same call
 * site produce the same key". The Crossdeck backend may refine the
 * grouping further once source maps are uploaded.
 *
 * Input: the message + the first ≤3 in-app frames. When no frames
 * are available (cross-origin Script error, non-Error throws,
 * unhandledrejection of a primitive), the optional `location`
 * fallback contributes filename:lineno:colno so otherwise-identical
 * "Unknown error" / "Script error" events from different call sites
 * stay separate. Without this fallback they all collapse into one
 * bucket and the dashboard can't distinguish them.
 *
 * Output: a short hex string usable as a Firestore doc id segment.
 */
export function fingerprintError(
  message: string,
  frames: StackFrame[],
  location?: {
    filename?: string | null;
    lineno?: number | null;
    colno?: number | null;
    errorType?: string | null;
  } | null,
): string {
  // Browser-injected-global errors (window.__firefox__, __gCrWeb, …) throw in
  // the page's global scope, so their only frame is the customer's own URL at
  // `:1:N`. Keyed the normal way they'd fingerprint by that page URL and
  // fragment per-page (and per-message: the `.reader` and `Can't find variable`
  // races would be separate issues). Key on the injected GLOBAL instead so the
  // whole class collapses to one demoted issue, regardless of page or race shape.
  const injected = injectedGlobalName(message);
  if (injected) return djb2Hex(`injected-global:${injected}`);

  const inAppFrames = frames.filter((f) => f.in_app).slice(0, 3);
  const parts = [
    (message || "").slice(0, 200),
    ...inAppFrames.map((f) => `${f.function}@${f.filename}:${f.lineno}`),
  ];
  // Only fold the location fallback in when frames are empty — adding
  // it on top of frames would split otherwise-identical errors across
  // different colno values from minified bundles.
  if (inAppFrames.length === 0 && location) {
    const loc = [
      location.errorType ?? "",
      location.filename ?? "",
      location.lineno ?? "",
      location.colno ?? "",
    ].join(":");
    if (loc !== ":::") parts.push(loc);
  }
  return djb2Hex(parts.join("|"));
}

/**
 * djb2 — small, fast non-cryptographic string hash. 32-bit output
 * encoded as 8-char hex. Stable across browsers; deterministic.
 */
function djb2Hex(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // Force unsigned then 8-char hex.
  return (h >>> 0).toString(16).padStart(8, "0");
}
