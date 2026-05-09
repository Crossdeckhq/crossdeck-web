/**
 * Local cache of active entitlements so isEntitled() can answer
 * synchronously after the first read. Cache is updated:
 *   - On successful getEntitlements()
 *   - On successful purchase()
 *   - Manually via setFromList() (used by callers that batch updates)
 *
 * The cache holds only ACTIVE entitlements — inactive ones are excluded
 * by the backend before they hit us. isEntitled returns false for
 * anything not in the set.
 *
 * Reactive listener API
 * ---------------------
 * `subscribe(listener)` registers a callback that fires every time the
 * cache mutates (setFromList or clear). This is the foundation for the
 * `useEntitlement` React hook in `@cross-deck/web/react` and any other
 * framework binding consumers need: SwiftUI's `@Observable`, Vue's
 * `ref()`, Solid's signals, etc.
 *
 * Why we need it: isEntitled() is a sync cache read — but if a React
 * component calls it in a render path, React has no way to know when
 * the cache populates asynchronously after `getEntitlements()` lands.
 * Without a subscribe API the component shows the empty-cache result
 * forever (until something else triggers a re-render). With it, the
 * binding can re-render when the data actually arrives.
 *
 * Listener semantics:
 *   - Fired AFTER the cache has been mutated (listener sees fresh state)
 *   - Fire-and-forget: thrown errors in a listener don't crash the SDK
 *     (they're swallowed; the next listener still runs)
 *   - The unsubscribe function returned from subscribe() is idempotent
 *   - Listeners are NOT fired on subscribe — caller is expected to
 *     read current state synchronously from isEntitled()/list() if it
 *     wants the initial render to reflect cached data
 *
 * Thread / re-entrancy safety: this is a synchronous in-memory Set with
 * no I/O. The async paths that update it are serialised through the
 * SDK's request queue — callers won't see torn reads.
 */

import type { PublicEntitlement } from "./types";

export type EntitlementsListener = (entitlements: PublicEntitlement[]) => void;

export class EntitlementCache {
  private active = new Set<string>();
  private all: PublicEntitlement[] = [];
  private lastUpdated = 0;
  private listeners = new Set<EntitlementsListener>();

  /** Sync read — true iff the entitlement key is currently active. */
  isEntitled(key: string): boolean {
    return this.active.has(key);
  }

  /** Full snapshot for callers that need source / validUntil details. */
  list(): PublicEntitlement[] {
    return this.all.slice();
  }

  /** When the cache was last refreshed. 0 means "never". */
  get freshness(): number {
    return this.lastUpdated;
  }

  /**
   * Replace the cache with a fresh server response. The backend already
   * filters to active + env-matching, so we don't re-filter — just trust
   * what we got.
   *
   * Fires listeners AFTER the mutation so each listener sees the new state.
   */
  setFromList(entitlements: PublicEntitlement[]): void {
    this.all = entitlements.slice();
    this.active = new Set(entitlements.filter((e) => e.isActive).map((e) => e.key));
    this.lastUpdated = Date.now();
    this.notify();
  }

  /**
   * Wipe — used on reset() (logout). The SDK forgets everything until
   * the next identify + read.
   *
   * Fires listeners so React/SwiftUI/etc bindings re-render to the
   * logged-out state immediately.
   */
  clear(): void {
    this.active.clear();
    this.all = [];
    this.lastUpdated = 0;
    this.notify();
  }

  /**
   * Subscribe to cache mutations. Returns an unsubscribe function.
   *
   * The listener is invoked AFTER setFromList() or clear() with the
   * current snapshot. Throwing inside a listener is non-fatal — the
   * error is swallowed and subsequent listeners still run.
   *
   * Used by `@cross-deck/web/react`'s `useEntitlement` hook to
   * trigger re-renders when entitlements change.
   */
  subscribe(listener: EntitlementsListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.all.slice();
    // Iterate over a snapshot of the listener set so a listener that
    // unsubscribes itself (or registers a new one) during dispatch
    // doesn't break the iteration.
    const listenersSnapshot = [...this.listeners];
    for (const listener of listenersSnapshot) {
      try {
        listener(snapshot);
      } catch {
        // Swallow listener errors — a buggy consumer shouldn't break
        // the SDK or other listeners.
      }
    }
  }
}
