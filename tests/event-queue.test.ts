import { describe, it, expect, vi } from "vitest";
import { EventQueue, type QueuedEvent } from "../src/event-queue";
import { PersistentEventStore } from "../src/event-storage";
import { MemoryStorage } from "../src/storage";
import { CrossdeckError } from "../src/errors";

function fakeEvent(name: string): QueuedEvent {
  return {
    eventId: `evt_${name}_${Math.random().toString(36).slice(2)}`,
    name,
    timestamp: Date.now(),
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

  it("re-buffers events at front of queue on network failure", async () => {
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
    expect(q.getStats().buffered).toBe(2); // back in the buffer
    expect(q.getStats().lastError).toContain("network down");
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
});
