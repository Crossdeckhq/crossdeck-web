/**
 * Local event queue + batched flush.
 *
 * Why a queue: track() is called from hot paths (button clicks, screen
 * views) and shouldn't block the UI on a network round-trip. Events go
 * into a local buffer, flushed in bursts.
 *
 * Flush triggers:
 *   - Buffer reaches batchSize (default 20) → flush immediately.
 *   - intervalMs of inactivity (default 1500ms) → flush idle batch.
 *   - flush() called explicitly (e.g. before page unload).
 *
 * Wave 1 hardening (v0.8.0+, the "bank-grade plumbing" pass):
 *
 *   - Exponential backoff with full jitter on flush failures. Respects
 *     server `Retry-After` headers (parsed onto CrossdeckError by the
 *     HTTP layer). Replaces the prior policy of "retry on the next
 *     idle window" which hot-looped against a flapping endpoint.
 *
 *   - Durable persistence. Events are written through to a
 *     `PersistentEventStore` (localStorage by default) so a hard
 *     browser crash / power loss / keepalive cap exceedance doesn't
 *     drop data. The next SDK boot replays the persisted queue.
 *
 *   - Per-batch `Idempotency-Key`. Same key is reused across retries
 *     of the SAME batch so the server can short-circuit duplicate work
 *     without inspecting bodies. The backend ALSO dedupes individual
 *     events via CH ReplacingMergeTree on `eventId`, so this is belt-
 *     and-suspenders.
 *
 *   - Property validation runs upstream in crossdeck.ts:track() — by
 *     the time an event lands in this queue, it's known to be safe
 *     to JSON.stringify.
 *
 * On a permanent network outage we keep retrying with bounded backoff;
 * we never drop events because of network failures alone. The only
 * drop path is the hard buffer cap (1000 events): once exceeded we
 * evict the OLDEST events and increment `dropped` so the developer
 * can see the loss in `diagnostics()`.
 */

import type { HttpClient } from "./http";
import type { EventProperties, IngestResponse } from "./types";
import type { CrossdeckError } from "./errors";
import { RetryPolicy, type RetryPolicyOptions } from "./retry-policy";
import { PersistentEventStore } from "./event-storage";
import { randomChars } from "./identity";

const HARD_BUFFER_CAP = 1000;

export interface QueuedEvent {
  eventId: string;
  name: string;
  timestamp: number;
  properties: EventProperties;
  // identity hint — at least anonymousId is always set
  developerUserId?: string;
  anonymousId?: string;
  crossdeckCustomerId?: string;
}

export interface BatchEnvelope {
  appId: string;
  environment: "production" | "sandbox";
  sdk: { name: string; version: string };
}

export interface EventQueueConfig {
  http: HttpClient;
  batchSize: number;
  intervalMs: number;
  /**
   * Returns the NorthStar §13.1 envelope to attach to each batch POST.
   * It's a function (not a value) so a future call to setDebugMode or a
   * config swap can update the envelope without re-instantiating the
   * queue.
   */
  envelope: () => BatchEnvelope;
  /** Schedule a function to run after `ms` ms. Default: setTimeout. Override for tests. */
  scheduler?: (fn: () => void, ms: number) => () => void;
  /** Called when the SDK drops events because the buffer is full. */
  onDrop?: (dropped: number) => void;
  /** Called once after the first successful flush — drives the §16 "First event sent" signal. */
  onFirstFlushSuccess?: () => void;
  /**
   * Durable persistence. When supplied, every buffer mutation is
   * written through to the store; on construction, persisted events
   * are loaded back into the buffer. Omitting this is fine for tests
   * and Node consumers — the queue falls back to in-memory only.
   */
  persistentStore?: PersistentEventStore;
  /** Retry policy overrides for failed flushes. */
  retry?: RetryPolicyOptions;
  /**
   * Called whenever an item is added to the buffer or removed by a
   * successful flush. Exposed so the host SDK can surface live queue
   * stats via diagnostics() without polling.
   */
  onBufferChange?: (size: number) => void;
  /**
   * Surface for the SDK's debug logger to record retry scheduling +
   * persistence events. Fired async — never throws.
   */
  onRetryScheduled?: (info: {
    delayMs: number;
    consecutiveFailures: number;
    retryAfterMs?: number;
    lastError: string;
  }) => void;
}

export interface EventQueueStats {
  buffered: number;
  dropped: number;
  inFlight: number;
  lastFlushAt: number;
  lastError: string | null;
  /** Consecutive flush failures since the last success. */
  consecutiveFailures: number;
  /** Set when the next flush is scheduled by the retry policy. */
  nextRetryAt: number | null;
}

export class EventQueue {
  private buffer: QueuedEvent[] = [];
  private dropped = 0;
  private inFlight = 0;
  private lastFlushAt = 0;
  private lastError: string | null = null;
  private cancelTimer: (() => void) | null = null;
  private firstFlushFired = false;
  private nextRetryAt: number | null = null;
  private readonly retry: RetryPolicy;
  private readonly persistent: PersistentEventStore | null;

  constructor(private readonly cfg: EventQueueConfig) {
    this.retry = new RetryPolicy(cfg.retry ?? {});
    this.persistent = cfg.persistentStore ?? null;

    // Rehydrate any events left over from a prior session (crash, hard
    // close, keepalive cap exceeded). Eventid-based dedup at the server
    // means re-sending an event that may have already landed is safe.
    if (this.persistent) {
      const restored = this.persistent.load();
      if (restored.length > 0) {
        // Apply the same hard cap on rehydrate — defends against a
        // malicious / corrupted blob with a million entries.
        if (restored.length > HARD_BUFFER_CAP) {
          this.dropped += restored.length - HARD_BUFFER_CAP;
          this.buffer = restored.slice(restored.length - HARD_BUFFER_CAP);
        } else {
          this.buffer = restored;
        }
        this.cfg.onBufferChange?.(this.buffer.length);
        // Schedule an immediate idle flush so rehydrated events land
        // on the next tick — even if no new track() call comes in.
        this.scheduleIdleFlush();
      }
    }
  }

  enqueue(event: QueuedEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > HARD_BUFFER_CAP) {
      const overflow = this.buffer.length - HARD_BUFFER_CAP;
      this.buffer.splice(0, overflow);
      this.dropped += overflow;
      this.cfg.onDrop?.(overflow);
    }
    this.cfg.onBufferChange?.(this.buffer.length);
    this.persistent?.save(this.buffer);
    if (this.buffer.length >= this.cfg.batchSize) {
      void this.flush();
    } else {
      this.scheduleIdleFlush();
    }
  }

  /**
   * Flush the buffer to /v1/events. Resolves when the network call
   * completes (success or failure). On failure, events stay in the
   * buffer for the next scheduled retry.
   *
   * `options.keepalive` marks the underlying fetch as keepalive so the
   * browser keeps the request alive past page unload. Use this for
   * terminal flushes (pagehide / visibilitychange→hidden / beforeunload).
   */
  async flush(options: { keepalive?: boolean } = {}): Promise<IngestResponse | null> {
    if (this.buffer.length === 0) return null;
    this.cancelTimerIfSet();
    this.nextRetryAt = null;

    // Snapshot the buffer for THIS batch. Use a stable batch id so
    // retries of the same logical batch reuse the same Idempotency-Key.
    const batch = this.buffer.splice(0);
    const batchId = this.mintBatchId();
    this.inFlight += batch.length;
    this.persistent?.save(this.buffer);
    this.cfg.onBufferChange?.(this.buffer.length);

    try {
      const env = this.cfg.envelope();
      const result = await this.cfg.http.request<IngestResponse>("POST", "/events", {
        body: {
          // NorthStar §13.1 batch envelope. The backend validates these
          // against the API-key-resolved app and rejects mismatches
          // loudly (env_mismatch).
          appId: env.appId,
          environment: env.environment,
          sdk: env.sdk,
          events: batch,
        },
        keepalive: options.keepalive === true,
        idempotencyKey: batchId,
      });
      this.lastFlushAt = Date.now();
      this.lastError = null;
      this.inFlight -= batch.length;
      this.retry.recordSuccess();
      // Persisted blob no longer needs these events.
      this.persistent?.save(this.buffer);
      if (!this.firstFlushFired) {
        this.firstFlushFired = true;
        this.cfg.onFirstFlushSuccess?.();
      }
      return result;
    } catch (err) {
      // Re-buffer at the FRONT so older events stay older — preserves
      // approximate ordering for the server's session reconstruction.
      this.buffer.unshift(...batch);
      this.inFlight -= batch.length;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.persistent?.save(this.buffer);
      this.cfg.onBufferChange?.(this.buffer.length);

      // Backoff: schedule a retry through the retry-policy module
      // instead of falling through to the idle timer (which would
      // fire at the same rate forever and hammer a flapping server).
      const retryAfterMs = extractRetryAfterMs(err);
      const delay = this.retry.nextDelay(retryAfterMs);
      this.scheduleRetry(delay);
      this.cfg.onRetryScheduled?.({
        delayMs: delay,
        consecutiveFailures: this.retry.consecutiveFailures,
        retryAfterMs,
        lastError: message,
      });
      return null;
    }
  }

  /** Cancel any pending timer and clear in-memory state. Wipes durable store too. */
  reset(): void {
    this.cancelTimerIfSet();
    this.nextRetryAt = null;
    this.buffer = [];
    this.dropped = 0;
    this.inFlight = 0;
    this.lastError = null;
    this.retry.recordSuccess();
    this.persistent?.clear();
    this.cfg.onBufferChange?.(0);
    // Note: we deliberately do NOT reset firstFlushFired — the
    // "First event sent" signal is a one-time onboarding moment per
    // SDK instance lifetime, not per-identity.
  }

  getStats(): EventQueueStats {
    return {
      buffered: this.buffer.length,
      dropped: this.dropped,
      inFlight: this.inFlight,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
      consecutiveFailures: this.retry.consecutiveFailures,
      nextRetryAt: this.nextRetryAt,
    };
  }

  // ---------- internal scheduling ----------

  private scheduleIdleFlush(): void {
    this.cancelTimerIfSet();
    const sched = this.cfg.scheduler ?? defaultScheduler;
    this.cancelTimer = sched(() => {
      void this.flush();
    }, this.cfg.intervalMs);
  }

  private scheduleRetry(delayMs: number): void {
    this.cancelTimerIfSet();
    this.nextRetryAt = Date.now() + delayMs;
    const sched = this.cfg.scheduler ?? defaultScheduler;
    this.cancelTimer = sched(() => {
      void this.flush();
    }, delayMs);
  }

  private cancelTimerIfSet(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }

  private mintBatchId(): string {
    return `batch_${Date.now().toString(36)}${randomChars(10)}`;
  }
}

function extractRetryAfterMs(err: unknown): number | undefined {
  if (err && typeof err === "object" && "retryAfterMs" in err) {
    const v = (err as CrossdeckError).retryAfterMs;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  }
  return undefined;
}

function defaultScheduler(fn: () => void, ms: number): () => void {
  // Use unref()-style behaviour where supported so a pending flush doesn't
  // block Node from exiting. setTimeout in browsers ignores .unref() —
  // that's fine.
  const id = setTimeout(fn, ms);
  if (typeof (id as unknown as { unref?: () => void }).unref === "function") {
    try {
      (id as unknown as { unref: () => void }).unref();
    } catch {
      // ignore — unref is best-effort
    }
  }
  return () => clearTimeout(id);
}
