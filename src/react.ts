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

import { useEffect, useState } from "react";
import { Crossdeck } from "./crossdeck";

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
