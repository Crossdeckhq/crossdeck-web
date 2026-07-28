/**
 * @cross-deck/web/react — React hooks for the Crossdeck SDK.
 *
 * Why this exists: `Crossdeck.isEntitled("pro")` is a synchronous cache
 * read, but the cache populates asynchronously after `getEntitlements()`
 * lands. React has no way to know the cache changed, so a component
 * that calls `isEntitled` directly in a render path would show the
 * empty-cache result forever (until something else triggered a re-render).
 *
 * The `useEntitlement` hook below ties cache state to React state via
 * `onEntitlementsChange`, so the component re-renders the moment the
 * answer changes. After the first render, every subsequent check is a
 * sync cache hit — exactly the "microsecond entitlement check" the
 * SDK promises.
 *
 * Side effect: importing this module pulls in `react` as a peer
 * dependency. Consumers who don't use React shouldn't import it.
 *
 * SSR safety: `useEffect` is a no-op during server-side rendering, and
 * the initial state is conservative (`false` until proven otherwise),
 * so server output never claims a non-existent entitlement. The hook
 * hydrates correctly on the client.
 *
 * NorthStar §11.4 (reactive bindings): every SDK ships first-class
 * framework bindings so the canonical snippet stays one line. Web =>
 * React hook here. iOS => `@Observable` SwiftUI wrapper (when iOS SDK
 * ships). Android => Compose `State<Boolean>` wrapper (when Android
 * SDK ships).
 */

import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Crossdeck } from "./singleton";
import type { CrossdeckOptions } from "./types";
import type { TrustToken, TrustTokenStatus } from "./trust";
export type { TrustTokenStatus };

// ─────────────────────────────────────────────────────────────────
// <CrossdeckProvider> — one-line React integration.
//
// What it does for the consumer:
//   1. Calls Crossdeck.init({ appId, publicKey, environment, ...rest })
//      once on first mount. React StrictMode re-mounts are de-duped
//      via a module-level "initialised" flag so init never runs twice.
//   2. Mirrors the `userId` prop into the SDK identity:
//        userId provided + changed → Crossdeck.identify(userId)
//        userId removed (logout)   → Crossdeck.reset()
//      Both calls are idempotent against the SDK — no extra wire-up.
//   3. Renders children unchanged. No context, no provider DOM node —
//      the SDK is a singleton, the "provider" is a side-effect mount
//      point that happens to look like a React provider.
//
// Why this exists: the dashboard's Next.js install prompt promised a
// <CrossdeckProvider userId={…} appId={…} publicKey={…} environment={…}>
// for months while @cross-deck/web/react only shipped useEntitlement /
// useEntitlements. Customers pasted the prompt verbatim, got an import
// error, fell off onboarding. This component closes the gap so the
// prompt's 8-line recipe is now accurate end-to-end.
//
// SSR safety: every side effect lives inside useEffect, which is a
// no-op during server render. Server output is exactly `children`.
// ─────────────────────────────────────────────────────────────────

let _moduleInitDone = false;

interface CrossdeckProviderProps extends Omit<CrossdeckOptions, "userId"> {
  /**
   * Optional. When defined, the provider calls Crossdeck.identify(userId)
   * after init and on every change. When the prop flips back to undefined
   * (logout), the provider calls Crossdeck.reset().
   *
   * Pass your auth library's stable user id directly:
   *   <CrossdeckProvider userId={session?.user?.id} … />          // NextAuth
   *   <CrossdeckProvider userId={user?.uid} … />                  // Firebase
   *   <CrossdeckProvider userId={supabase.auth.user()?.id} … />   // Supabase
   *
   * Anonymous (pre-login) traffic stays anonymous until userId becomes
   * defined — the SDK's anonymousId follows the same user record once
   * identify lands, so attribution survives sign-up.
   */
  userId?: string | null | undefined;
  children: ReactNode;
}

export function CrossdeckProvider(props: CrossdeckProviderProps): ReactNode {
  const { userId, children, ...initOptions } = props;
  // Track the last userId we sent to identify(), so we don't re-call
  // identify on every render — only on actual transitions. Module-scope
  // `_moduleInitDone` covers init de-dup; this ref covers identify.
  const lastUserIdRef = useRef<string | null | undefined>(undefined);

  // Init — once per module load, guarded against StrictMode's
  // double-mount-in-dev so we never re-install the unload-flush
  // listeners or reset the device-info cache.
  useEffect(() => {
    if (_moduleInitDone) return;
    try {
      Crossdeck.init(initOptions);
      _moduleInitDone = true;
    } catch (err) {
      // Surface configuration errors loudly. The most common cause is
      // a key/environment mismatch — letting it crash the provider
      // tree would crash the whole app, which is worse than a console
      // error during dogfood. Init failures are not recoverable
      // mid-render, so we just log and let the rest of the app run
      // un-initialized (every Crossdeck.* call will throw not_initialized
      // until the operator fixes the config).
      if (typeof console !== "undefined") {
        console.error("[CrossdeckProvider] init failed:", err);
      }
    }
    // Intentionally no deps: init runs once. Changing appId / publicKey
    // / environment at runtime is not supported (re-mount the provider
    // on a new key — usually unnecessary in real apps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Identity — mirror userId prop into SDK identity. Runs after init
  // and on every userId change. No-op when the value matches what we
  // last sent (avoids redundant network calls on parent re-renders).
  useEffect(() => {
    if (!_moduleInitDone) return;
    if (lastUserIdRef.current === userId) return;
    lastUserIdRef.current = userId;
    try {
      if (userId) {
        // identify returns a Promise but we deliberately don't await
        // it inside the effect — the cache populates async, and
        // useEntitlement subscribes to mutations, so the UI catches up
        // automatically the moment the response lands. Fire-and-forget
        // is the documented pattern.
        void Crossdeck.identify(userId);
      } else {
        Crossdeck.reset();
      }
    } catch (err) {
      if (typeof console !== "undefined") {
        console.error("[CrossdeckProvider] identity sync failed:", err);
      }
    }
  }, [userId]);

  return children;
}

/**
 * Subscribe a React component to a single entitlement key.
 *
 * The hook returns the current `isEntitled(key)` value AND keeps it in
 * sync with the cache. When `getEntitlements()` lands, when a purchase
 * adds an entitlement, or when `reset()` is called on logout, every
 * component using this hook re-renders to reflect the change.
 *
 * Usage:
 *
 *   import { useEntitlement } from "@cross-deck/web/react";
 *
 *   function ProBadge() {
 *     const isPro = useEntitlement("pro");
 *     return isPro ? <span className="badge">Pro</span> : null;
 *   }
 *
 * Note that the hook does NOT call `getEntitlements()` itself — that's
 * a one-time boot warm-up the consumer is expected to trigger after
 * `Crossdeck.init()` (typically inside a top-level effect in their
 * Providers wrapper). Once warmed, every component using this hook
 * gets the answer for free.
 *
 * Pre-init: returns `false`. Calling Crossdeck.init() later doesn't
 * automatically refresh existing hook instances — but as soon as
 * something mutates the cache (i.e. after a successful
 * getEntitlements() call on the new SDK instance), the hook fires.
 */
export function useEntitlement(key: string): boolean {
  // Initial value: read the cache synchronously if init() has happened.
  // If not, default to false (the hook's contract: "false until proven
  // otherwise"). Wrapping in a try/catch because isEntitled throws if
  // called pre-init — we treat pre-init as "not entitled yet."
  const [isEntitled, setIsEntitled] = useState<boolean>(() => safeIsEntitled(key));

  useEffect(() => {
    // Re-read on mount in case init() ran between the initial state
    // calculation and the effect attaching (rare in React, but happens
    // with concurrent rendering / suspense boundaries).
    setIsEntitled(safeIsEntitled(key));

    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = Crossdeck.onEntitlementsChange(() => {
        setIsEntitled(safeIsEntitled(key));
      });
    } catch {
      // Pre-init — onEntitlementsChange throws if the SDK hasn't been
      // started yet. The hook will have to wait for the consumer to
      // call init() and then for something to trigger a re-render
      // through normal React means (parent state change, etc).
      //
      // Most apps init() once in a top-level Provider before any
      // useEntitlement consumer mounts, so this is rare in practice.
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [key]);

  return isEntitled;
}

/**
 * Subscribe to the full entitlement list. Returns an array of active
 * entitlement keys, kept in sync with the cache. Useful for iterating
 * (e.g. rendering a list of unlocked features in a settings page).
 *
 * Same pre-init / SSR semantics as `useEntitlement`.
 */
export function useEntitlements(): readonly string[] {
  const [keys, setKeys] = useState<readonly string[]>(() => safeListKeys());

  useEffect(() => {
    setKeys(safeListKeys());

    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = Crossdeck.onEntitlementsChange((entitlements) => {
        setKeys(entitlements.filter((e) => e.isActive).map((e) => e.key));
      });
    } catch {
      // Pre-init — see useEntitlement for rationale.
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  return keys;
}

function safeIsEntitled(key: string): boolean {
  try {
    return Crossdeck.isEntitled(key);
  } catch {
    return false;
  }
}

function safeListKeys(): readonly string[] {
  try {
    return Crossdeck.listEntitlements()
      .filter((e) => e.isActive)
      .map((e) => e.key);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// Crossdeck Trust — the human-proof panel as a first-class React surface.
//
// <CrossdeckTrust onToken={...} /> renders the branded, un-restylable Trust
// iframe and hands you the minted token. `useTrustToken()` is the headless
// equivalent for when you want the value in state. Both sit on
// `Crossdeck.trust.panel(...)`, take the publishable key from the Provider's
// init(), and are fail-open: if the panel can't mint, your signup still works
// and the server scores the absent token. Never throws, never blocks the form.
// ─────────────────────────────────────────────────────────────────

export interface CrossdeckTrustProps {
  /**
   * The project's publishable key (cd_pub_…). Pass it here — the robust, explicit way
   * (like Stripe / Turnstile) — and no `Crossdeck.init()` / `<CrossdeckProvider>` is
   * needed. Omit it and the SDK falls back to the key from `init()`.
   */
  publicKey?: string;
  /** Called once when the panel mints a token. Pass `t.token` to your gate call. */
  onToken?: (t: TrustToken) => void;
  /**
   * Called if the panel could not mint (adblocker, offline, our outage, timeout).
   * INFORMATIONAL — not an error to handle. The signup should still proceed.
   */
  onUnavailable?: (reason: string) => void;
  /** Class on the wrapper element the panel mounts into. */
  className?: string;
  /** Inline style on the wrapper element. */
  style?: CSSProperties;
  /** id on the wrapper element. */
  id?: string;
}

/**
 * `<CrossdeckTrust onToken={setToken} />` — drop it on your signup form. Renders
 * the same cross-origin Trust panel every install gets, mints a single-use
 * attestation, and calls `onToken` with it. SSR-safe (mounts on the client).
 */
export function CrossdeckTrust(props: CrossdeckTrustProps): ReactNode {
  const { publicKey, onToken, onUnavailable, className, style, id } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest callbacks without re-mounting the panel on every render.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onUnavailRef = useRef(onUnavailable);
  onUnavailRef.current = onUnavailable;

  useEffect(() => {
    if (!hostRef.current) return;
    const handle = Crossdeck.trust.panel({
      target: hostRef.current,
      publicKey,
      onToken: (t) => onTokenRef.current?.(t),
      onUnavailable: (r) => onUnavailRef.current?.(r),
    });
    return () => handle.destroy();
    // Mount once — the panel mints once per lifecycle. Re-mount to re-mint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createElement("div", { ref: hostRef, className, style, id });
}

/**
 * Headless Trust — mount the panel and read the token from React state.
 *
 * @example
 * const { ref, token, status } = useTrustToken();
 * return <><input name="email" /><div ref={ref} /></>;
 * // then send `token` to your server; `status` is "pending" | "ready" | "unavailable".
 */
export function useTrustToken(opts?: {
  /** Explicit publishable key (cd_pub_…) — no `init()` needed. Falls back to init's key. */
  publicKey?: string;
}): {
  /** Attach to the element the panel should mount into: `<div ref={ref} />`. */
  ref: RefObject<HTMLDivElement | null>;
  /** The minted token, or null until it mints (or if the panel failed open). */
  token: string | null;
  /** Lifecycle: pending → ready (minted) or unavailable (failed open). */
  status: TrustTokenStatus;
} {
  const publicKey = opts?.publicKey;
  const ref = useRef<HTMLDivElement | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<TrustTokenStatus>("pending");

  useEffect(() => {
    if (!ref.current) return;
    const handle = Crossdeck.trust.panel({
      target: ref.current,
      publicKey,
      onToken: (t) => {
        setToken(t.token);
        setStatus("ready");
      },
      onUnavailable: () => setStatus("unavailable"),
    });
    return () => handle.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ref, token, status };
}
