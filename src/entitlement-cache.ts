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

import { sha256Hex } from "./hash";
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

/** Anonymous suffix used before identify() has been called. Stable
 * across launches so an anonymous session's cache survives a reload
 * — but physically separate from any identified user's cache. */
const ANON_SUFFIX = "_anon";

/** Suffix for the index entry that tracks every per-user key we've
 * written. Used by clearAll() to scope a logout-wipe to ONLY
 * Crossdeck keys, never the host app's own localStorage. */
const INDEX_SUFFIX = "_index";

export class EntitlementCache {
  private all: PublicEntitlement[] = [];
  private lastUpdated = 0;
  private lastRefreshFailedAt = 0;
  private listeners = new Set<EntitlementsListener>();
  private listenerErrorCount = 0;
  private readonly storage?: KeyValueStorage;
  private readonly storageKeyPrefix: string;
  private readonly staleAfterMs: number;
  private currentSuffix: string = ANON_SUFFIX;
  private _generation = 0;

  /**
   * Monotonic identity generation. Bumped on every setUserKey() (identity
   * switch OR same-id re-identify). An async getEntitlements() captures this
   * before its await and drops its write if the generation moved while the
   * request was in flight — so a stale fetch (e.g. the anonymous boot fetch,
   * or one started under a prior slot) can never clobber the authoritative
   * answer for the user who is identified NOW. Last-writer-wins is the enemy;
   * this makes the write conditional on "still the same identity".
   */
  get generation(): number {
    return this._generation;
  }

  /**
   * @param storage          Device storage adapter. When omitted (tests) or
   *                         a MemoryStorage (strict-consent / no-persistence
   *                         mode) the cache is session-only — durability is
   *                         simply absent, never wrong.
   * @param storageKeyPrefix Prefix used to derive per-user storage keys
   *                         (`<prefix>:<sha256(userId)>`). Default
   *                         `crossdeck:entitlements`. The trailing user
   *                         suffix is filled at identify() / reset()
   *                         time — see [[setUserKey]].
   * @param staleAfterMs     Age past which last-known-good is flagged stale
   *                         even without a failed refresh. Default 24h.
   */
  constructor(
    storage?: KeyValueStorage,
    storageKeyPrefix = "crossdeck:entitlements",
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
  ) {
    this.storage = storage;
    this.storageKeyPrefix = storageKeyPrefix;
    this.staleAfterMs = staleAfterMs;
    this.hydrate();
  }

  /** The full storage key the current-user blob is persisted under. */
  private get storageKey(): string {
    return `${this.storageKeyPrefix}:${this.currentSuffix}`;
  }

  /** Key of the index blob — a JSON array of every suffix we've
   * written. Used by clearAll() to scope a logout-wipe. */
  private get indexKey(): string {
    return `${this.storageKeyPrefix}:${INDEX_SUFFIX}`;
  }

  /** Derive a stable suffix for a developerUserId via SHA-256. The
   * raw userId never lands in the storage key — protects against
   * accidentally leaking email-style identifiers through DevTools
   * inspection. Pass `null` to switch back to the anonymous slot. */
  static suffixForUserId(userId: string | null): string {
    if (userId == null || userId === "") return ANON_SUFFIX;
    return sha256Hex(userId);
  }

  /**
   * Switch the cache to a different user's storage slot. Bank-grade
   * three-layer isolation:
   *   (a) Physical key separation — `<prefix>:<sha256(userId)>` so
   *       a user-switch can't physically read prior user's data
   *       even if the in-memory clear was skipped.
   *   (b) Unconditional in-memory clear — invoked whenever the
   *       active suffix changes, even on same-id re-identify.
   *   (c) Re-hydrate from the new slot — a returning user observes
   *       their last-known-good cache from storage immediately.
   *
   * Caller (identify() / reset()) MUST invoke this BEFORE the next
   * setFromList() so the write lands under the right key.
   */
  setUserKey(userId: string | null): void {
    // ONE code path for both the different-user switch AND the same-id
    // re-identify (React/Vue providers call identify() 2–3 times as auth
    // traits populate in stages: uid, then email, then profile name).
    //
    // Order is load-bearing and was the bug: hydrate() BEFORE notify().
    // The previous same-id branch did notify() FIRST (emitting an EMPTY
    // snapshot) then hydrate() SILENTLY — so every onEntitlementsChange
    // subscriber (useEntitlement / useEntitlements / the Vue composable /
    // any hand-rolled listener) latched `[]` → rendered the paywall → and
    // was never told to re-read, because the restore didn't notify. The
    // in-memory `all` ended up correct (which is why synchronous
    // isEntitled() and the server-side gate were never wrong, and why the
    // per-user-cache-isolation self-check stayed quiet), but the EMITTED
    // stream was corrupted. Restore first, then emit the SETTLED state
    // exactly once: subscribers never observe an empty flash.
    this.currentSuffix = EntitlementCache.suffixForUserId(userId); // no-op if unchanged
    this._generation++; // invalidate any getEntitlements() in flight under the old identity
    this.all = []; // unconditional in-memory clear (founder contract) — transient, no notify between
    this.lastUpdated = 0;
    this.lastRefreshFailedAt = 0;
    this.hydrate(); // restore THIS slot's last-known-good first
    this.notify(); // emit the settled snapshot once
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

  /**
   * True iff the in-memory snapshot is exactly what the CURRENT slot holds in
   * storage — i.e., it was hydrated from THIS slot, never leaked from another.
   *
   * This is the real per-user isolation invariant after a slot rotation: the
   * snapshot is sourced from the new slot's storage — empty for a first-time
   * user, or that user's OWN last-known-good for a returning one (the
   * intentional rehydrate, layer (c) of setUserKey). It is NEVER the prior
   * user's data. Asserting "empty after rotation" is too strict — it false-
   * fails a returning user legitimately re-reading their own cache.
   * Session-only (no storage) can't diverge, so it is trivially isolated.
   */
  snapshotMatchesCurrentSlot(): boolean {
    if (!this.storage) return true;
    let persisted: PublicEntitlement[] = [];
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedCache;
        if (parsed && parsed.v === 1 && Array.isArray(parsed.entitlements)) {
          persisted = parsed.entitlements;
        }
      }
    } catch {
      return false;
    }
    const norm = (l: PublicEntitlement[]) =>
      l.map((e) => `${e.key}|${e.isActive}|${e.validUntil}`).sort().join(",");
    return norm(this.all) === norm(persisted);
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
    this.recordSuffixInIndex(this.currentSuffix);
    this.notify();
  }

  /**
   * Wipe the CURRENT user's slot. Used internally when a single
   * user's cache needs to be invalidated without affecting other
   * persisted slots. The full-logout path is [[clearAll]].
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
    this.removeSuffixFromIndex(this.currentSuffix);
    this.notify();
  }

  /**
   * Logout-grade wipe — bank-grade contract: removes EVERY per-user
   * entitlement slot the SDK has ever written on this device, then
   * clears the index. Used by `Crossdeck.reset()` so a logout on a
   * shared device can never leave another user's entitlements
   * readable (layer (c) of the v1.4.0 isolation fix).
   *
   * After clearAll(), the cache is back to anonymous + empty.
   */
  clearAll(): void {
    this.all = [];
    this.lastUpdated = 0;
    this.lastRefreshFailedAt = 0;
    this.currentSuffix = ANON_SUFFIX;
    if (this.storage) {
      const suffixes = this.readIndex();
      for (const suffix of suffixes) {
        try {
          this.storage.removeItem(`${this.storageKeyPrefix}:${suffix}`);
        } catch {
          // best-effort
        }
      }
      // Also remove the anonymous slot explicitly — it may not have
      // been indexed if the cache was wiped before its first write.
      try {
        this.storage.removeItem(`${this.storageKeyPrefix}:${ANON_SUFFIX}`);
      } catch {
        // best-effort
      }
      try {
        this.storage.removeItem(this.indexKey);
      } catch {
        // best-effort
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

  /** Read the index of all per-user suffixes the SDK has written. */
  private readIndex(): string[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(this.indexKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string");
      }
      return [];
    } catch {
      return [];
    }
  }

  /** Add a suffix to the persisted index. Idempotent. */
  private recordSuffixInIndex(suffix: string): void {
    if (!this.storage) return;
    const existing = this.readIndex();
    if (existing.includes(suffix)) return;
    existing.push(suffix);
    try {
      this.storage.setItem(this.indexKey, JSON.stringify(existing));
    } catch {
      // best-effort
    }
  }

  /** Remove a suffix from the persisted index. No-op if absent. */
  private removeSuffixFromIndex(suffix: string): void {
    if (!this.storage) return;
    const existing = this.readIndex();
    const next = existing.filter((s) => s !== suffix);
    if (next.length === existing.length) return;
    try {
      if (next.length === 0) {
        this.storage.removeItem(this.indexKey);
      } else {
        this.storage.setItem(this.indexKey, JSON.stringify(next));
      }
    } catch {
      // best-effort
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
