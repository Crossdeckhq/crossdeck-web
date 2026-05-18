/**
 * Durable last-known-good cache of the customer's entitlements.
 *
 * This cache is NOT a second source of truth. Crossdeck remains the
 * only source; this is the SDK's local copy of what the server last
 * told us — a cache that doesn't forget during a network partition.
 *
 * Durability contract (the RevenueCat model):
 *   - Every successful server read is persisted to device storage
 *     (localStorage, via the SDK's storage adapter).
 *   - On SDK boot the cache hydrates from storage synchronously, so
 *     isEntitled() answers correctly from the very first call — there
 *     is no cold-start window where a returning Pro customer reads as
 *     free.
 *   - When the server is unreachable, the SDK keeps serving the last
 *     entitlements it successfully fetched. A failed refresh never
 *     reaches setFromList(), so it cannot clear the cache; only a
 *     SUCCESSFUL fetch replaces it. An outage can never fail a paying
 *     customer down to free.
 *   - Staleness alone never returns false. Each entitlement is honoured
 *     against its OWN validUntil instead — a time-based trial expiry
 *     still applies even mid-partition, a still-valid Pro entitlement
 *     rides the outage out.
 *   - Staleness is VISIBLE, not silent. validUntil covers time-based
 *     expiry; it does NOT cover an event-based revoke (chargeback,
 *     refund, fraud) — that has no validUntil, so the cache would keep
 *     serving a revoked customer through an outage. Serving them is the
 *     right trade (don't lock real payers out), but unbounded-and-
 *     invisible is the bug. So: once a refresh ATTEMPT fails (or the
 *     data ages past staleAfterMs) the cache is marked stale —
 *     isStale / freshness are surfaced in diagnostics(). It keeps
 *     serving last-known-good; the staleness is just no longer hidden.
 *
 * The cache is wiped only on reset() (logout) and on an identity switch
 * — never by a TTL.
 *
 * Reactive listener API
 * ---------------------
 * `subscribe(listener)` registers a callback fired every time the cache
 * mutates (setFromList or clear) — the foundation for the
 * `useEntitlement` React hook and other framework bindings. Semantics:
 *   - Fired AFTER the mutation, so the listener sees fresh state.
 *   - Fire-and-forget: a throwing listener is swallowed (and counted)
 *     so a buggy consumer can't crash the SDK or other listeners.
 *   - Unsubscribe is idempotent.
 *   - Listeners are NOT fired on subscribe — a caller that wants the
 *     initial state reads isEntitled() / list() synchronously, which
 *     work from boot thanks to hydration above.
 */

import type { KeyValueStorage, PublicEntitlement } from "./types";

export type EntitlementsListener = (entitlements: PublicEntitlement[]) => void;

/** Shape of the blob persisted to device storage. Versioned for forward-compat. */
interface PersistedCache {
  v: 1;
  entitlements: PublicEntitlement[];
  lastUpdated: number;
}

/** Default staleness window — data older than this is flagged even with no failed refresh. */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

export class EntitlementCache {
  private all: PublicEntitlement[] = [];
  private lastUpdated = 0;
  private lastRefreshFailedAt = 0;
  private listeners = new Set<EntitlementsListener>();
  private listenerErrorCount = 0;
  private readonly storage?: KeyValueStorage;
  private readonly storageKey: string;
  private readonly staleAfterMs: number;

  /**
   * @param storage      Device storage adapter. When omitted (tests) or
   *                     a MemoryStorage (strict-consent / no-persistence
   *                     mode) the cache is session-only — durability is
   *                     simply absent, never wrong.
   * @param storageKey   Full key the persisted blob lives under.
   * @param staleAfterMs Age past which last-known-good is flagged stale
   *                     even without a failed refresh. Default 24h.
   */
  constructor(
    storage?: KeyValueStorage,
    storageKey = "crossdeck:entitlements",
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
  ) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.staleAfterMs = staleAfterMs;
    this.hydrate();
  }

  /**
   * Sync read — true iff the entitlement is currently granting access.
   *
   * Served from last-known-good: a stale cache (server unreachable since
   * the last successful fetch) still answers true for a still-valid
   * entitlement. The ONLY thing that turns it false is the entitlement's
   * own expiry (validUntil) — never overall cache staleness.
   */
  isEntitled(key: string): boolean {
    const nowSec = Date.now() / 1000;
    return this.all.some(
      (e) =>
        e.key === key &&
        e.isActive &&
        (e.validUntil == null || e.validUntil > nowSec),
    );
  }

  /** Full snapshot for callers that need source / validUntil details. */
  list(): PublicEntitlement[] {
    return this.all.slice();
  }

  /** When the cache was last refreshed from the server. 0 means "never". */
  get freshness(): number {
    return this.lastUpdated;
  }

  /**
   * Whether the cache is knowingly serving older-than-trustworthy data.
   *
   * True when the most recent refresh ATTEMPT failed (Crossdeck
   * unreachable since the last success — the outage case, distinct from
   * a benign idle tab that simply hasn't re-fetched), OR when
   * last-known-good has aged past staleAfterMs.
   *
   * isStale never changes what isEntitled() returns — the cache still
   * serves last-known-good. It exists so the staleness is observable
   * (diagnostics()) instead of an unbounded silent window where a
   * revoked customer holds access with nobody able to see it.
   */
  get isStale(): boolean {
    if (this.lastRefreshFailedAt > this.lastUpdated) return true;
    return (
      this.lastUpdated > 0 &&
      Date.now() - this.lastUpdated > this.staleAfterMs
    );
  }

  /** Epoch ms of the last failed refresh attempt. 0 if none since the last success. */
  get refreshFailedAt(): number {
    return this.lastRefreshFailedAt;
  }

  get listenerErrors(): number {
    return this.listenerErrorCount;
  }

  /**
   * Record that a refresh attempt failed (Crossdeck unreachable / a
   * transient error). The SDK's getEntitlements() calls this in its
   * catch path. It does NOT touch the cached entitlements — last-known-
   * good keeps serving — it only flips isStale so the staleness shows
   * up in diagnostics() rather than being silent.
   */
  markRefreshFailed(): void {
    this.lastRefreshFailedAt = Date.now();
  }

  /**
   * Replace the cache with a fresh server response and persist it to
   * device storage so it survives a reload / app restart.
   *
   * Called ONLY after a successful server read — a failed fetch throws
   * before it reaches here, so last-known-good is preserved through an
   * outage. A success also clears the stale flag.
   */
  setFromList(entitlements: PublicEntitlement[]): void {
    this.all = entitlements.slice();
    this.lastUpdated = Date.now();
    this.lastRefreshFailedAt = 0;
    this.persist();
    this.notify();
  }

  /**
   * Wipe — used on reset() (logout) and on an identity switch. Clears
   * BOTH memory and durable storage so a prior user's entitlements can
   * never leak to the next person on this device.
   */
  clear(): void {
    this.all = [];
    this.lastUpdated = 0;
    this.lastRefreshFailedAt = 0;
    if (this.storage) {
      try {
        this.storage.removeItem(this.storageKey);
      } catch {
        // Private mode / quota — best-effort, same posture as storage.ts.
      }
    }
    this.notify();
  }

  /**
   * Subscribe to cache mutations. Returns an idempotent unsubscribe fn.
   * The listener fires AFTER setFromList() or clear() with the current
   * snapshot. Used by `@cross-deck/web/react`'s `useEntitlement` hook.
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

  // ----- Durable persistence -----

  /**
   * Load last-known-good from device storage. Runs once in the
   * constructor, synchronously, so isEntitled() is correct from boot.
   * Any corrupt / unparseable blob degrades silently to an empty cache —
   * boot must never throw.
   */
  private hydrate(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedCache;
      if (parsed && parsed.v === 1 && Array.isArray(parsed.entitlements)) {
        this.all = parsed.entitlements;
        this.lastUpdated =
          typeof parsed.lastUpdated === "number" ? parsed.lastUpdated : 0;
      }
    } catch {
      // Corrupt / unparseable blob → start empty. Never throw on boot.
    }
  }

  /** Write last-known-good to device storage. Best-effort. */
  private persist(): void {
    if (!this.storage) return;
    try {
      const blob: PersistedCache = {
        v: 1,
        entitlements: this.all,
        lastUpdated: this.lastUpdated,
      };
      this.storage.setItem(this.storageKey, JSON.stringify(blob));
    } catch {
      // Quota exceeded / private mode — the in-memory cache still works
      // for this session; we just lose cross-reload durability.
    }
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.all.slice();
    // Iterate a snapshot of the listener set so a listener that
    // unsubscribes itself (or registers a new one) during dispatch
    // doesn't break the iteration.
    const listenersSnapshot = [...this.listeners];
    for (const listener of listenersSnapshot) {
      try {
        listener(snapshot);
      } catch {
        // Swallow listener errors — a buggy consumer shouldn't break the
        // SDK or other listeners. Counted for diagnostics().
        this.listenerErrorCount += 1;
      }
    }
  }
}
