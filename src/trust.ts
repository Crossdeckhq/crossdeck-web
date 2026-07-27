/**
 * Crossdeck Trust — the human-proof panel, native to the SDK.
 *
 * This is the browser half of Crossdeck Trust wired THROUGH the SDK the customer
 * already runs, not bolted on beside it. It renders the SAME cross-origin iframe
 * served from trust.cross-deck.com — the un-restylable, browser-enforced brand
 * panel — and hands the minted attestation back PROGRAMMATICALLY (a Promise + an
 * `onToken` callback) instead of the hidden-field/DOM handshake the raw
 * `embed.js` loader uses. The iframe is the bouncer; the SDK is the premium front
 * door to it. You pass the token to your server, which verifies it at the gate
 * (`crossdeck.trust.gate(...)` in @cross-deck/node, or a raw POST /v1/trust/gate).
 *
 * Non-negotiables baked in (Stripe / Cloudflare / bank grade):
 *  - ISOLATED — every DOM / postMessage touch is wrapped; a stumble here can never
 *    throw into the host app, the rest of the SDK, or the customer's signup form.
 *  - FAIL-OPEN, never fail-allow — if the panel can't mint (adblocker, our outage,
 *    offline, timeout), `ready` resolves with NO token. The signup proceeds; the
 *    SERVER gate scores the ABSENCE. We never wave a tokenless request through, and
 *    we never block the form because our panel had a bad day. Failing CLOSED would
 *    hand an attacker a site-wide-outage weapon — so we never do.
 *  - ORIGIN-LOCKED — we only trust messages from OUR panel origin AND from this
 *    exact iframe's window. Nothing on the host page can forge a token.
 *  - The token is minted INSIDE our origin; the host page (even an XSS on it) never
 *    participates in the mint, it only receives the finished token.
 */

/** The origin that serves the branded, un-restylable Trust panel. */
export const TRUST_PANEL_ORIGIN = "https://trust.cross-deck.com";

/** Size clamps — identical to embed.js so the panel is the same on every install. */
const MAX_WIDTH_PX = 360;
const INITIAL_HEIGHT_PX = 132;
const MIN_HEIGHT_PX = 96;
const MAX_HEIGHT_PX = 220;
const DEFAULT_TIMEOUT_MS = 15000;

/** A minted human-proof attestation. Pass `token` to your gate call. */
export interface TrustToken {
  /** The single-use, project-bound attestation to send to your server as `token`. */
  token: string;
  /** Epoch ms at which the token expires (mint fresh per signup attempt), or null. */
  expiresAt: number | null;
}

/** Resolution of a panel that failed open — a token never minted. Not an error. */
export interface TrustUnavailable {
  token: null;
  expiresAt: null;
  /** Why no token was minted (for your logs) — e.g. "timeout", "blocked", "offline". */
  reason: string;
}

export type TrustResult = TrustToken | TrustUnavailable;

/** Lifecycle of a panel driven by a framework binding: pending → ready | unavailable. */
export type TrustTokenStatus = "pending" | "ready" | "unavailable";

export interface MountTrustPanelOptions {
  /** The project's publishable key (cd_pub_…). The SDK client supplies this for you. */
  publicKey: string;
  /** Where to render the panel — an element or a selector resolved at mount time. */
  target: HTMLElement | string;
  /** Called once when a token is minted. Optional — you can await `ready` instead. */
  onToken?: (t: TrustToken) => void;
  /**
   * Called if the panel could not mint (blocked, offline, timeout, our outage).
   * INFORMATIONAL for your logs — NOT an error you must handle: `ready` still
   * resolves and your signup proceeds. Fail-open is the contract.
   */
  onUnavailable?: (reason: string) => void;
  /** Override the panel origin (tests / self-host). Defaults to production. */
  origin?: string;
  /** Max wait for a mint before failing open, in ms. Default 15000. */
  timeoutMs?: number;
}

export interface TrustPanelHandle {
  /** The iframe we mounted — for layout/measurement only; never reach inside it. */
  readonly frame: HTMLIFrameElement | null;
  /**
   * Resolves EXACTLY once: the token on success, or a {@link TrustUnavailable} if
   * the panel failed open. NEVER rejects — a rejection would tempt callers to block
   * the signup, which is precisely what fail-open forbids.
   */
  readonly ready: Promise<TrustResult>;
  /** Tear down: remove the iframe + listeners. Idempotent. */
  destroy(): void;
}

/**
 * Options for `Crossdeck.trust.panel(...)` — the same as {@link MountTrustPanelOptions}
 * but the SDK client injects `publicKey` from your `init()`, so you omit it.
 */
export type TrustPanelInput = Omit<MountTrustPanelOptions, "publicKey"> & {
  /**
   * The project's publishable key (cd_pub_…). Pass it **explicitly** — the robust,
   * Stripe (`loadStripe(pk)`) / Cloudflare Turnstile (`sitekey`) pattern — and the
   * panel needs no `Crossdeck.init()` at all. Omit it and the SDK falls back to the
   * key from `init()`. Explicit always wins.
   */
  publicKey?: string;
};

/** The `Crossdeck.trust` namespace surfaced on the SDK client. */
export interface CrossdeckTrustNamespace {
  /** Render the branded Trust panel and mint an attestation. See {@link mountTrustPanel}. */
  panel(input: TrustPanelInput): TrustPanelHandle;
}

/**
 * Mount the Crossdeck Trust panel and mint an attestation. Framework-agnostic and
 * guaranteed not to throw — any construction failure resolves `ready` fail-open.
 */
export function mountTrustPanel(opts: MountTrustPanelOptions): TrustPanelHandle {
  const origin = normalizeOrigin(opts.origin) || TRUST_PANEL_ORIGIN;
  const timeoutMs = clampInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120000);

  let settled = false;
  let onMessage: ((ev: MessageEvent) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: HTMLIFrameElement | null = null;

  let resolveReady!: (v: TrustResult) => void;
  const ready = new Promise<TrustResult>((res) => {
    resolveReady = res;
  });

  /** Single, idempotent exit — success AND fail-open both come through here. */
  function settle(result: TrustToken | null, reason?: string): void {
    if (settled) return;
    settled = true;
    if (timer) safe(() => clearTimeout(timer as ReturnType<typeof setTimeout>));
    if (onMessage) safe(() => window.removeEventListener("message", onMessage as EventListener));
    if (result) {
      safe(() => opts.onToken?.(result));
      resolveReady(result);
    } else {
      const why = reason || "unavailable";
      safe(() => opts.onUnavailable?.(why));
      resolveReady({ token: null, expiresAt: null, reason: why });
    }
  }

  try {
    if (typeof window === "undefined" || typeof document === "undefined") {
      // SSR / non-browser — nothing to mount. Fail open on the next tick.
      queueMicrotask(() => settle(null, "no_dom"));
      return makeHandle();
    }

    const host = resolveTarget(opts.target);
    frame = createFrame(origin, opts.publicKey);

    if (!host) {
      queueMicrotask(() => settle(null, "no_mount_target"));
      return makeHandle();
    }

    onMessage = (ev: MessageEvent) => {
      // ORIGIN LOCK #1 — only our panel origin.
      if (ev.origin !== origin) return;
      // ORIGIN LOCK #2 — only THIS iframe's window (blocks any other frame/tab).
      if (!ev.data || !frame || ev.source !== frame.contentWindow) return;
      const d = ev.data as { type?: string; height?: number; token?: string; expMs?: number };
      if (d.type === "cd-trust-size" && typeof d.height === "number") {
        safe(() => {
          if (frame) frame.style.height = clampInt(d.height, INITIAL_HEIGHT_PX, MIN_HEIGHT_PX, MAX_HEIGHT_PX) + "px";
        });
      } else if (d.type === "cd-trust-token" && typeof d.token === "string") {
        settle({ token: d.token, expiresAt: typeof d.expMs === "number" ? d.expMs : null });
      }
    };
    window.addEventListener("message", onMessage);
    host.appendChild(frame);

    // Fail-open guard: if no mint arrives in time, proceed tokenless.
    timer = setTimeout(() => settle(null, "timeout"), timeoutMs);
  } catch (err) {
    // ANY construction failure fails open. The host never sees a throw.
    queueMicrotask(() => settle(null, "mount_error:" + safeMessage(err)));
  }

  return makeHandle();

  function makeHandle(): TrustPanelHandle {
    return {
      frame,
      ready,
      destroy() {
        if (onMessage) safe(() => window.removeEventListener("message", onMessage as EventListener));
        if (timer) safe(() => clearTimeout(timer as ReturnType<typeof setTimeout>));
        safe(() => frame?.parentNode?.removeChild(frame as HTMLIFrameElement));
        // If torn down before minting, release any awaiting caller (fail-open).
        settle(null, "destroyed");
      },
    };
  }
}

/** Build the branded iframe — same fixed, capped footprint as embed.js. */
function createFrame(origin: string, publicKey: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.title = "Protected by Crossdeck Trust";
  frame.setAttribute("aria-label", "Protected by Crossdeck Trust");
  frame.setAttribute("scrolling", "no");
  frame.setAttribute("allowtransparency", "true");
  frame.style.cssText =
    "border:0;display:block;width:100%;max-width:" +
    MAX_WIDTH_PX +
    "px;height:" +
    INITIAL_HEIGHT_PX +
    "px;margin:0;background:transparent;color-scheme:light;";
  frame.src = origin + "/panel?k=" + encodeURIComponent(publicKey || "");
  return frame;
}

function resolveTarget(target: HTMLElement | string): HTMLElement | null {
  try {
    if (typeof target === "string") return document.querySelector(target);
    return target || null;
  } catch {
    return null;
  }
}

function normalizeOrigin(o?: string): string | null {
  if (!o || typeof o !== "string") return null;
  try {
    return new URL(o).origin;
  } catch {
    return null;
  }
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" && isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* isolation: a stumble here must never escape into the host app */
  }
}

function safeMessage(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unknown";
  }
}
