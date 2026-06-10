import { describe, it, expect, vi } from "vitest";
import { EventQueue, type QueuedEvent } from "../src/event-queue";
import { PersistentEventStore } from "../src/event-storage";
import { MemoryStorage } from "../src/storage";
import { CrossdeckError } from "../src/errors";

function fakeEvent(name: string, seq = 0): QueuedEvent {
  return {
    eventId: `evt_${name}_${Math.random().toString(36).slice(2)}`,
    name,
    timestamp: Date.now(),
    seq,
    context: {},
    properties: {},
    anonymousId: "anon_test",
  };
}

function fakeHttp(behaviour: "ok" | "fail" = "ok") {
  return {
    request: vi.fn().mockImplementation(async () => {
      if (behaviour === "fail") throw new Error("network down");
      return { object: "list", received: 0, env: "production" };
    }),
  };
}

const TEST_ENVELOPE = () => ({
  appId: "app_web_test",
  environment: "sandbox" as const,
  sdk: { name: "@cross-deck/web", version: "0.3.0" },
});

describe("EventQueue", () => {
  it("flushes immediately when batchSize is reached", async () => {
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 3,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {}, // never fire idle timer
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    expect(http.request).toHaveBeenCalledTimes(0);
    q.enqueue(fakeEvent("c"));
    // flush is async — let microtasks settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(http.request).toHaveBeenCalledTimes(1);
    const body = http.request.mock.calls[0]![2].body as { events: QueuedEvent[] };
    expect(body.events.length).toBe(3);
  });

  it("idle flush via custom scheduler", async () => {
    const http = fakeHttp("ok");
    let triggerIdle: (() => void) | null = null;
    const q = new EventQueue({
      http: http as never,
      batchSize: 100,
      intervalMs: 5,
      envelope: TEST_ENVELOPE,
      scheduler: (fn) => {
        triggerIdle = fn;
        return () => {
          triggerIdle = null;
        };
      },
    });
    q.enqueue(fakeEvent("a"));
    expect(triggerIdle).toBeTruthy();
    triggerIdle!();
    await new Promise((r) => setTimeout(r, 0));
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("keeps events in the pendingBatch slot on network failure (NOT re-buffered)", async () => {
    // Bank-grade contract: pre-fix a failed flush unshifted events back
    // into the outer buffer and minted a NEW batchId on the next attempt
    // — defeating the backend's Idempotency-Key dedup. New behavior keeps
    // the events in the `pendingBatch` slot with the SAME batchId so
    // retries reuse the key (Stripe pattern, now matching node).
    const http = fakeHttp("fail");
    const q = new EventQueue({
      http: http as never,
      batchSize: 2,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    await new Promise((r) => setTimeout(r, 0));
    // Events live in pendingBatch (`inFlight`), not in the outer
    // `buffered` count. A new enqueue during this window lands in the
    // buffer for the NEXT batch, not appended to the in-flight one.
    expect(q.getStats().buffered).toBe(0);
    expect(q.getStats().inFlight).toBe(2);
    expect(q.getStats().lastError).toContain("network down");
    expect(q.pendingIdempotencyKey).toMatch(/^batch_/);
  });

  it("flush() with empty buffer is a no-op", async () => {
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 100,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
    });
    const result = await q.flush();
    expect(result).toBeNull();
    expect(http.request).toHaveBeenCalledTimes(0);
  });

  it("hard cap drops the OLDEST events when buffer overflows (1000 max)", async () => {
    const http = fakeHttp("ok");
    let droppedNotified = 0;
    const q = new EventQueue({
      http: http as never,
      batchSize: 100_000, // never auto-flush from batchSize
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      onDrop: (n) => {
        droppedNotified += n;
      },
    });
    for (let i = 0; i < 1005; i++) q.enqueue(fakeEvent(`e${i}`));
    expect(q.getStats().buffered).toBe(1000);
    expect(q.getStats().dropped).toBe(5);
    expect(droppedNotified).toBe(5);
  });

  it("reset() clears buffer + cancels timer", async () => {
    const http = fakeHttp("ok");
    let cancelled = false;
    const q = new EventQueue({
      http: http as never,
      batchSize: 100,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {
        cancelled = true;
      },
    });
    q.enqueue(fakeEvent("a"));
    q.reset();
    expect(q.getStats().buffered).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("survives concurrent enqueue + flush without dropping events", async () => {
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 5,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
    });
    // Enqueue 5 to trigger a flush, then enqueue more during the in-flight call
    for (let i = 0; i < 5; i++) q.enqueue(fakeEvent(`a${i}`));
    for (let i = 0; i < 3; i++) q.enqueue(fakeEvent(`b${i}`));
    await new Promise((r) => setTimeout(r, 0));
    // First batch was sent; the 3 new events stay in the buffer
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(q.getStats().buffered).toBe(3);
  });
});

// ============================================================
// Event Envelope v1 — envelopeVersion on the batch body
// ============================================================

describe("EventQueue — Event Envelope v1 wire shape", () => {
  it("adds envelopeVersion: 1 to every batch POST body (§1)", async () => {
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
    });
    q.enqueue(fakeEvent("test"));
    await new Promise((r) => setTimeout(r, 0));
    const body = http.request.mock.calls[0]![2].body as { envelopeVersion: number };
    expect(body.envelopeVersion).toBe(1);
  });

  it("envelopeVersion is distinct from sdk.version in the same body (§1)", async () => {
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
    });
    q.enqueue(fakeEvent("test"));
    await new Promise((r) => setTimeout(r, 0));
    const body = http.request.mock.calls[0]![2].body as {
      envelopeVersion: number;
      sdk: { version: string };
    };
    // envelopeVersion is always the integer 1; sdk.version is a semver string
    expect(body.envelopeVersion).toBe(1);
    expect(typeof body.sdk.version).toBe("string");
    expect(body.sdk.version).not.toBe("1"); // never conflated
  });
});

// ============================================================
// Wave 1 — Idempotency-Key + retry policy + durable persistence
// ============================================================

describe("EventQueue — Idempotency-Key", () => {
  it("sends a unique Idempotency-Key per batch", async () => {
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 2,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    await new Promise((r) => setTimeout(r, 0));
    q.enqueue(fakeEvent("c"));
    q.enqueue(fakeEvent("d"));
    await new Promise((r) => setTimeout(r, 0));
    expect(http.request).toHaveBeenCalledTimes(2);
    const key1 = http.request.mock.calls[0]![2].idempotencyKey as string;
    const key2 = http.request.mock.calls[1]![2].idempotencyKey as string;
    expect(key1).toMatch(/^batch_/);
    expect(key2).toMatch(/^batch_/);
    expect(key1).not.toBe(key2);
  });
});

describe("EventQueue — retry policy on failure", () => {
  it("schedules a retry via the scheduler with non-zero delay", async () => {
    const http = fakeHttp("fail");
    const scheduled: number[] = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: (_fn, ms) => {
        scheduled.push(ms);
        return () => {};
      },
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 10));
    // With batchSize=1 the enqueue triggers an immediate flush (no idle
    // timer), then the failure schedules exactly one retry.
    expect(scheduled.length).toBe(1);
    const retryDelay = scheduled[0]!;
    expect(retryDelay).toBeGreaterThanOrEqual(0);
    expect(retryDelay).toBeLessThanOrEqual(2000); // first backoff window
    expect(q.getStats().consecutiveFailures).toBe(1);
    expect(q.getStats().nextRetryAt).toBeGreaterThan(0);
  });

  it("honours server Retry-After when larger than computed window", async () => {
    const http = {
      request: vi.fn().mockRejectedValue(
        new CrossdeckError({
          type: "rate_limit_error",
          code: "rate_limited",
          message: "slow",
          retryAfterMs: 5_000,
        }),
      ),
    };
    let lastDelay = 0;
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: (_fn, ms) => {
        lastDelay = ms;
        return () => {};
      },
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 10));
    expect(lastDelay).toBe(5_000);
  });

  it("resets consecutiveFailures on a successful flush", async () => {
    let shouldFail = true;
    const http = {
      request: vi.fn().mockImplementation(async () => {
        if (shouldFail) throw new Error("network down");
        return { object: "list", received: 0, env: "production" };
      }),
    };
    let triggerRetry: (() => void) | null = null;
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: (fn) => {
        triggerRetry = fn;
        return () => {};
      },
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 10));
    expect(q.getStats().consecutiveFailures).toBe(1);
    // Flip behaviour, fire the retry.
    shouldFail = false;
    triggerRetry!();
    await new Promise((r) => setTimeout(r, 10));
    expect(q.getStats().consecutiveFailures).toBe(0);
    expect(q.getStats().nextRetryAt).toBeNull();
  });

  it("emits onRetryScheduled with full context", async () => {
    const http = fakeHttp("fail");
    const retryEvents: Array<Record<string, unknown>> = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      onRetryScheduled: (info) => retryEvents.push(info),
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 10));
    expect(retryEvents.length).toBe(1);
    expect(retryEvents[0]).toMatchObject({
      consecutiveFailures: 1,
      lastError: "network down",
    });
  });
});

describe("EventQueue — durable persistence", () => {
  it("rehydrates events from a prior session on construction", async () => {
    const storage = new MemoryStorage();
    const store = new PersistentEventStore({ storage, prefix: "cd:" });
    store.saveSync([fakeEvent("prior_a"), fakeEvent("prior_b")]);

    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 100,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      persistentStore: new PersistentEventStore({ storage, prefix: "cd:" }),
    });
    expect(q.getStats().buffered).toBe(2);
  });

  it("writes the buffer through to the persistent store on enqueue", async () => {
    const storage = new MemoryStorage();
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 100,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      persistentStore: new PersistentEventStore({ storage, prefix: "cd:" }),
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    await Promise.resolve();
    await Promise.resolve();
    const persisted = new PersistentEventStore({ storage, prefix: "cd:" }).load();
    expect(persisted.length).toBe(2);
  });

  it("clears the persistent store on successful flush", async () => {
    const storage = new MemoryStorage();
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      persistentStore: new PersistentEventStore({ storage, prefix: "cd:" }),
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 10));
    await Promise.resolve();
    const persisted = new PersistentEventStore({ storage, prefix: "cd:" }).load();
    expect(persisted).toEqual([]);
  });

  it("reset() wipes the persistent store", async () => {
    const storage = new MemoryStorage();
    const http = fakeHttp("ok");
    const q = new EventQueue({
      http: http as never,
      batchSize: 100,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      persistentStore: new PersistentEventStore({ storage, prefix: "cd:" }),
    });
    q.enqueue(fakeEvent("a"));
    await Promise.resolve();
    q.reset();
    await Promise.resolve();
    expect(storage.getItem("cd:queue.v1")).toBeNull();
  });

  it("retains the in-flight batch in persistent storage across a network failure (P0 #4 regression)", async () => {
    // Pre-fix the queue did `persistent.save(empty)` BEFORE awaiting
    // the network call — a hard-crash mid-flight wiped the persisted
    // blob and the batch was lost forever. Post-fix `persistAll()`
    // always saves [...pendingBatch, ...buffer] so the in-flight batch
    // survives until the server confirms it.
    const storage = new MemoryStorage();
    const http = fakeHttp("fail");
    const q = new EventQueue({
      http: http as never,
      batchSize: 2,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      persistentStore: new PersistentEventStore({ storage, prefix: "cd:" }),
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    await new Promise((r) => setTimeout(r, 0));
    // Network call failed; persisted blob must STILL contain both
    // events so a hard-crash here gets a replay on next boot.
    const persisted = new PersistentEventStore({ storage, prefix: "cd:" }).load();
    expect(persisted.length).toBe(2);
    expect(persisted.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("persistAll() includes in-flight pendingBatch alongside new buffer enqueues during retry window", async () => {
    // Simulates the "crash between failed flush and retry" durability
    // contract: while a batch is stuck in pendingBatch, a new enqueue
    // also lands in the persisted blob. On crash, the next boot
    // rehydrates BOTH the in-flight events and the newer ones.
    const storage = new MemoryStorage();
    const http = fakeHttp("fail");
    const q = new EventQueue({
      http: http as never,
      batchSize: 2,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      persistentStore: new PersistentEventStore({ storage, prefix: "cd:" }),
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    await new Promise((r) => setTimeout(r, 0));
    q.enqueue(fakeEvent("c"));
    await Promise.resolve();
    await Promise.resolve();
    const persisted = new PersistentEventStore({ storage, prefix: "cd:" }).load();
    expect(persisted.length).toBe(3);
    expect(persisted.map((e) => e.name).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("EventQueue — retry Idempotency-Key reuse (Stripe pattern)", () => {
  it("retried flush of the SAME batch reuses the SAME Idempotency-Key (P0 #4 regression)", async () => {
    // Pre-fix every retry minted a fresh batchId via splice + mintBatchId,
    // defeating server-side dedup. Post-fix the batchId stays on the
    // pendingBatch slot and is reused until the batch either succeeds or
    // is permanently dropped.
    let attempt = 0;
    const http = {
      request: vi.fn().mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network down");
        return { object: "list", received: 0, env: "production" };
      }),
    };
    let triggerRetry: (() => void) | null = null;
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: (fn) => {
        triggerRetry = fn;
        return () => {};
      },
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 10));
    const firstKey = http.request.mock.calls[0]![2].idempotencyKey as string;
    expect(firstKey).toMatch(/^batch_/);
    // pendingBatch holds the events with the SAME key.
    expect(q.pendingIdempotencyKey).toBe(firstKey);
    // Fire the retry — should re-attempt with the SAME key.
    triggerRetry!();
    await new Promise((r) => setTimeout(r, 10));
    const secondKey = http.request.mock.calls[1]![2].idempotencyKey as string;
    expect(secondKey).toBe(firstKey);
    // After success the slot clears so the NEXT logical batch gets a fresh key.
    expect(q.pendingIdempotencyKey).toBeNull();
  });
});

describe("EventQueue — permanent failure on 4xx (P0 #6)", () => {
  function fake4xx(status: number, code: string): { request: ReturnType<typeof vi.fn> } {
    return {
      request: vi.fn().mockRejectedValue(
        new CrossdeckError({ type: "invalid_request_error", code, message: `HTTP ${status}`, status }),
      ),
    };
  }

  it("drops the batch and fires onPermanentFailure on 401 (key revoked)", async () => {
    const http = fake4xx(401, "invalid_api_key");
    const drops: number[] = [];
    const perm: Array<{ status: number; droppedCount: number; lastError: string }> = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 2,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      // The captured scheduler captures BOTH the idle-flush schedule
      // (fired by the first enqueue when buffer length < batchSize)
      // AND any retry schedules. We don't care about the idle one —
      // we care that the queue didn't schedule a RETRY after the
      // permanent failure. `getStats().nextRetryAt === null` is the
      // canonical signal for that.
      scheduler: () => () => {},
      onDrop: (n) => drops.push(n),
      onPermanentFailure: (info) => perm.push(info),
    });
    q.enqueue(fakeEvent("a"));
    q.enqueue(fakeEvent("b"));
    await new Promise((r) => setTimeout(r, 0));
    expect(drops).toEqual([2]);
    expect(perm).toEqual([{ status: 401, droppedCount: 2, lastError: "HTTP 401" }]);
    // CRITICAL: no retry scheduled — the whole point of the fix.
    expect(q.getStats().nextRetryAt).toBeNull();
    expect(q.getStats().consecutiveFailures).toBe(0);
    expect(q.getStats().buffered).toBe(0);
    expect(q.getStats().inFlight).toBe(0);
    expect(q.getStats().dropped).toBe(2);
    expect(q.pendingIdempotencyKey).toBeNull();
  });

  it("drops on 400 (malformed batch)", async () => {
    const http = fake4xx(400, "invalid_event");
    const perm: Array<{ status: number }> = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: () => () => {},
      onPermanentFailure: (info) => perm.push({ status: info.status }),
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(perm).toEqual([{ status: 400 }]);
  });

  it("RETAINS the batch on 408 (transient timeout — retryable)", async () => {
    const http = fake4xx(408, "request_timeout");
    const scheduled: number[] = [];
    const perm: Array<unknown> = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: (_fn, ms) => {
        scheduled.push(ms);
        return () => {};
      },
      onPermanentFailure: (info) => perm.push(info),
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(perm).toEqual([]);
    expect(scheduled.length).toBe(1);
    expect(q.getStats().inFlight).toBe(1);
  });

  it("RETAINS the batch on 429 (rate-limited — retryable, honours Retry-After)", async () => {
    const http = {
      request: vi.fn().mockRejectedValue(
        new CrossdeckError({
          type: "rate_limit_error",
          code: "rate_limited",
          message: "slow",
          status: 429,
          retryAfterMs: 2_500,
        }),
      ),
    };
    const scheduled: number[] = [];
    const perm: Array<unknown> = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: (_fn, ms) => {
        scheduled.push(ms);
        return () => {};
      },
      onPermanentFailure: (info) => perm.push(info),
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(perm).toEqual([]);
    expect(scheduled[0]).toBe(2_500); // honours server Retry-After
  });

  it("RETAINS the batch on a network error (no status field — retryable)", async () => {
    const http = fakeHttp("fail"); // throws plain Error, no status
    const perm: Array<unknown> = [];
    const scheduled: number[] = [];
    const q = new EventQueue({
      http: http as never,
      batchSize: 1,
      intervalMs: 10_000,
      envelope: TEST_ENVELOPE,
      scheduler: (_fn, ms) => {
        scheduled.push(ms);
        return () => {};
      },
      onPermanentFailure: (info) => perm.push(info),
    });
    q.enqueue(fakeEvent("a"));
    await new Promise((r) => setTimeout(r, 0));
    // Conservative default: only flag permanent on clear 4xx evidence.
    expect(perm).toEqual([]);
    expect(scheduled.length).toBe(1);
    expect(q.getStats().inFlight).toBe(1);
  });
});
