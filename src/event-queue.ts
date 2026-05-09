/**
 * Local event queue + batched flush.
 *
 * Why a queue: track() is called from hot paths (button clicks, screen
 * views) and shouldn't block the UI on a network round-trip. Events go
 * into a local buffer, flushed in bursts.
 *
 * Flush triggers:
 *   - Buffer reaches batchSize (default 20) → flush immediately
 *   - intervalMs of inactivity (default 5000) → flush idle batch
 *   - flush() called explicitly (e.g. before page unload)
 *
 * On network failure, the events stay in the buffer for the next flush
 * — bounded retry that doesn't drop events when the network blips.
 *
 * The cap on buffer size (1000 events) protects against runaway memory
 * if the network is permanently down — beyond that we drop the oldest
 * event and increment a dropped counter (exposed via getStats()).
 */

import type { HttpClient } from "./http";
import type { EventProperties, IngestResponse } from "./types";

const HARD_BUFFER_CAP = 1000;

export interface QueuedEvent {
  eventId: string;
  name: string;
  timestamp: number;
  properties: EventProperties;
  // identity hint — exactly one will be set
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
}

export interface EventQueueStats {
  buffered: number;
  dropped: number;
  inFlight: number;
  lastFlushAt: number;
  lastError: string | null;
}

export class EventQueue {
  private buffer: QueuedEvent[] = [];
  private dropped = 0;
  private inFlight = 0;
  private lastFlushAt = 0;
  private lastError: string | null = null;
  private cancelTimer: (() => void) | null = null;
  private firstFlushFired = false;

  constructor(private readonly cfg: EventQueueConfig) {}

  enqueue(event: QueuedEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > HARD_BUFFER_CAP) {
      const overflow = this.buffer.length - HARD_BUFFER_CAP;
      this.buffer.splice(0, overflow);
      this.dropped += overflow;
      this.cfg.onDrop?.(overflow);
    }
    if (this.buffer.length >= this.cfg.batchSize) {
      void this.flush();
    } else {
      this.scheduleIdleFlush();
    }
  }

  /**
   * Flush the buffer to /v1/events. Resolves when the network call
   * completes (success or failure). On failure, events stay in the
   * buffer for the next flush attempt.
   */
  async flush(): Promise<IngestResponse | null> {
    if (this.buffer.length === 0) return null;
    this.cancelTimerIfSet();

    // Capture the current buffer; replace with a new array so concurrent
    // enqueue() calls during the in-flight request don't get lost.
    const batch = this.buffer.splice(0);
    this.inFlight += batch.length;

    try {
      const env = this.cfg.envelope();
      const result = await this.cfg.http.request<IngestResponse>("POST", "/events", {
        body: {
          // NorthStar §13.1 batch envelope. The backend validates these
          // against the API-key-resolved app and rejects mismatches loudly
          // (env_mismatch).
          appId: env.appId,
          environment: env.environment,
          sdk: env.sdk,
          events: batch,
        },
      });
      this.lastFlushAt = Date.now();
      this.lastError = null;
      this.inFlight -= batch.length;
      if (!this.firstFlushFired) {
        this.firstFlushFired = true;
        this.cfg.onFirstFlushSuccess?.();
      }
      return result;
    } catch (err) {
      // Re-buffer at the front of the queue. Order matters less than
      // not losing events — the backend will dedupe on eventId.
      this.buffer.unshift(...batch);
      this.inFlight -= batch.length;
      this.lastError = err instanceof Error ? err.message : String(err);
      // Schedule another idle flush so a transient outage recovers.
      this.scheduleIdleFlush();
      return null;
    }
  }

  /** Cancel any pending timer and clear in-memory state. */
  reset(): void {
    this.cancelTimerIfSet();
    this.buffer = [];
    this.dropped = 0;
    this.inFlight = 0;
    this.lastError = null;
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
    };
  }

  private scheduleIdleFlush(): void {
    this.cancelTimerIfSet();
    const sched = this.cfg.scheduler ?? defaultScheduler;
    this.cancelTimer = sched(() => {
      void this.flush();
    }, this.cfg.intervalMs);
  }

  private cancelTimerIfSet(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }
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
