/**
 * Durable event-queue persistence.
 *
 * Why this exists: the in-memory event-queue is fragile. Three failure
 * modes lose data today:
 *
 *   1. Page unload with a failed terminal flush. `keepalive: true`
 *      survives the unload, but only up to 64 KB total across all
 *      keepalive requests. A large batch on a slow network drops past
 *      that cap.
 *   2. Hard browser crash / power loss. The in-memory buffer goes with
 *      the process.
 *   3. Network down for longer than the user's session. Events that
 *      stay in the in-memory buffer disappear when the tab closes.
 *
 * Stripe / Segment / PostHog all persist queued events to a durable
 * store (localStorage for browsers, IndexedDB for very large queues,
 * AsyncStorage on RN) and replay them on the next boot. We do the
 * same here with localStorage as the default backing store.
 *
 * Failure modes handled gracefully:
 *   - Storage throws (quota exceeded, private mode, sandboxed iframe)
 *     → silent degrade to in-memory only. The SDK keeps working; the
 *     durability guarantee is best-effort.
 *   - Persisted blob unparseable on next boot (manual corruption,
 *     schema drift) → drop silently, fresh empty queue. Don't crash
 *     the consumer app on a bad localStorage value.
 *   - Storage write contention from another tab → last-writer-wins is
 *     fine because every queued event has an `eventId` and the
 *     backend dedupes via ReplacingMergeTree. Cross-tab coordination
 *     via BroadcastChannel is a Phase 2 follow-up.
 *
 * The storage key is `${prefix}queue.v1` to leave room for future
 * format migrations.
 */

import type { KeyValueStorage } from "./types";
import type { QueuedEvent } from "./event-queue";

export interface PersistentEventStoreOptions {
  storage: KeyValueStorage;
  prefix: string;
}

/**
 * Wire format for persisted batches. Versioned so a future change to
 * QueuedEvent shape can be detected + ignored cleanly.
 */
interface PersistedQueue {
  version: 1;
  events: QueuedEvent[];
}

export class PersistentEventStore {
  private readonly key: string;
  private writeScheduled = false;
  // Pending events captured on the most recent write request. We keep
  // the latest snapshot ref so a debounced write always picks up the
  // freshest buffer state.
  private pendingSnapshot: QueuedEvent[] | null = null;

  constructor(private readonly options: PersistentEventStoreOptions) {
    this.key = `${options.prefix}queue.v1`;
  }

  /**
   * Read the persisted queue on boot. Returns an empty array (with no
   * warning) when nothing is stored, the blob is malformed, or storage
   * is unavailable. Caller is responsible for treating duplicates from
   * the persisted queue as the SAME events (eventId-based dedup).
   */
  load(): QueuedEvent[] {
    let raw: string | null;
    try {
      raw = this.options.storage.getItem(this.key);
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as PersistedQueue;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.events)) {
        return [];
      }
      return parsed.events;
    } catch {
      // Corrupt blob — drop silently. Next save() overwrites.
      return [];
    }
  }

  /**
   * Schedule a write of the current buffer. Debounced via microtask so
   * a burst of enqueue() calls coalesces into one persistence write.
   * Writes are best-effort: if storage throws (quota, private mode),
   * we swallow and rely on the in-memory buffer.
   */
  save(snapshot: readonly QueuedEvent[]): void {
    // Defensive copy so a later mutation of the buffer doesn't change
    // what we're about to persist.
    this.pendingSnapshot = snapshot.slice();
    if (this.writeScheduled) return;
    this.writeScheduled = true;
    queueMicrotask(() => this.flushWrite());
  }

  /** Synchronous variant for terminal flushes (pagehide / beforeunload). */
  saveSync(snapshot: readonly QueuedEvent[]): void {
    this.pendingSnapshot = snapshot.slice();
    this.flushWrite();
  }

  /** Wipe the persisted blob. Used by reset() (logout). */
  clear(): void {
    this.pendingSnapshot = null;
    this.writeScheduled = false;
    try {
      this.options.storage.removeItem(this.key);
    } catch {
      // ignore
    }
  }

  private flushWrite(): void {
    this.writeScheduled = false;
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = null;
    if (snapshot === null) return;

    if (snapshot.length === 0) {
      try {
        this.options.storage.removeItem(this.key);
      } catch {
        // ignore
      }
      return;
    }

    const blob: PersistedQueue = { version: 1, events: snapshot };
    try {
      this.options.storage.setItem(this.key, JSON.stringify(blob));
    } catch {
      // Quota exceeded / private mode / etc. — silent degrade. The
      // in-memory buffer is still authoritative; we just lose
      // crash-safety for this batch.
    }
  }
}
