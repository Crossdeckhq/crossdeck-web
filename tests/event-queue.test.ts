import { describe, it, expect, vi } from "vitest";
import { EventQueue, type QueuedEvent } from "../src/event-queue";

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
