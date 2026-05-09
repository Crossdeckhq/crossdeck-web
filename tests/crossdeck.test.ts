/**
 * End-to-end tests for the public Crossdeck client. Stubs fetch globally
 * so we exercise the full SDK code path (start → identify → events → etc.)
 * without a backend.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CrossdeckClient } from "../src/crossdeck";
import { CrossdeckError } from "../src/errors";
import { MemoryStorage } from "../src/storage";

const ORIG_FETCH = globalThis.fetch;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function newClient(opts: Partial<Parameters<CrossdeckClient["init"]>[0]> = {}) {
  const c = new CrossdeckClient();
  c.init({
    appId: "app_web_test",
    publicKey: "cd_pub_test_001",
    environment: "sandbox",
    storage: new MemoryStorage(),
    autoHeartbeat: false,
    ...opts,
  });
  return c;
}

beforeEach(() => {
  // Reset the global fetch before each test
  globalThis.fetch = ORIG_FETCH;
});
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe("init", () => {
  it("rejects an invalid publishable key prefix", () => {
    const c = new CrossdeckClient();
    expect(() =>
      c.init({
        appId: "app_web_test",
        publicKey: "sk_xxxx" as never,
        environment: "sandbox",
      }),
    ).toThrowError(CrossdeckError);
  });

  it("requires a publishable key", () => {
    const c = new CrossdeckClient();
    expect(() =>
      c.init({
        appId: "app_web_test",
        publicKey: "" as never,
        environment: "sandbox",
      }),
    ).toThrowError(CrossdeckError);
  });

  it("requires appId", () => {
    const c = new CrossdeckClient();
    expect(() =>
      c.init({
        appId: "" as never,
        publicKey: "cd_pub_test_001",
        environment: "sandbox",
      }),
    ).toThrowError(CrossdeckError);
  });

  it("rejects environment mismatch with key prefix", () => {
    const c = new CrossdeckClient();
    expect(() =>
      c.init({
        appId: "app_web_test",
        publicKey: "cd_pub_live_xxxx",
        environment: "sandbox",
      }),
    ).toThrowError(CrossdeckError);
  });

  it("start() still works as a deprecated alias", () => {
    const c = new CrossdeckClient();
    expect(() =>
      c.start({
        appId: "app_web_test",
        publicKey: "cd_pub_test_001",
        environment: "sandbox",
        storage: new MemoryStorage(),
        autoHeartbeat: false,
      }),
    ).not.toThrow();
    expect(c.diagnostics().started).toBe(true);
  });

  it("auto-heartbeats by default", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "heartbeat",
        ok: true,
        projectId: "p",
        appId: "a",
        platform: "web",
        env: "production",
        serverTime: Date.now(),
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const c = new CrossdeckClient();
    c.init({
      appId: "app_web_test",
      publicKey: "cd_pub_test_001",
      environment: "sandbox",
      storage: new MemoryStorage(),
    });
    // Wait microtasks for the fire-and-forget heartbeat.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalled();
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/sdk/heartbeat");
  });

  it("does not auto-heartbeat when autoHeartbeat:false", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    newClient();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe("requireStarted (calling methods before init)", () => {
  it("throws not_initialized on every method when init() not called", async () => {
    const c = new CrossdeckClient();
    expect(() => c.isEntitled("pro")).toThrowError(CrossdeckError);
    expect(() => c.track("name")).toThrowError(CrossdeckError);
    await expect(c.identify("u1")).rejects.toThrow(CrossdeckError);
    await expect(c.getEntitlements()).rejects.toThrow(CrossdeckError);
    await expect(c.heartbeat()).rejects.toThrow(CrossdeckError);
  });
});

describe("identify", () => {
  it("calls /v1/identity/alias with userId + anonymousId, persists cdcust", async () => {
    const c = newClient();
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "alias_result",
        crossdeckCustomerId: "cdcust_user_001",
        linked: [],
        mergePending: false,
        env: "production",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await c.identify("user_847");
    expect(result.crossdeckCustomerId).toBe("cdcust_user_001");
    expect(c.diagnostics().crossdeckCustomerId).toBe("cdcust_user_001");
    expect(c.diagnostics().developerUserId).toBe("user_847");

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.userId).toBe("user_847");
    expect(body.anonymousId).toMatch(/^anon_/);
  });

  it("rejects empty userId", async () => {
    const c = newClient();
    await expect(c.identify("")).rejects.toThrow(CrossdeckError);
  });
});

describe("getEntitlements + isEntitled", () => {
  it("populates the cache and answers isEntitled synchronously", async () => {
    const c = newClient();
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "list",
        data: [
          {
            object: "entitlement",
            key: "pro",
            isActive: true,
            validUntil: null,
            source: { rail: "stripe", productId: "monthly_pro", subscriptionId: "sub_x" },
            updatedAt: 1700000000,
          },
        ],
        crossdeckCustomerId: "cdcust_xx",
        env: "production",
      }),
    ) as unknown as typeof fetch;

    expect(c.isEntitled("pro")).toBe(false); // cold cache
    await c.getEntitlements();
    expect(c.isEntitled("pro")).toBe(true);
    expect(c.isEntitled("garbage")).toBe(false);
    expect(c.diagnostics().crossdeckCustomerId).toBe("cdcust_xx");
  });

  it("uses customerId in query when cdcust is known", async () => {
    const c = newClient();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "alias_result",
          crossdeckCustomerId: "cdcust_known",
          linked: [],
          mergePending: false,
          env: "production",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "list",
          data: [],
          crossdeckCustomerId: "cdcust_known",
          env: "production",
        }),
      );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await c.identify("user_001");
    await c.getEntitlements();
    const [url] = fetchSpy.mock.calls[1]!;
    expect(url).toContain("customerId=cdcust_known");
  });

  it("uses anonymousId when no cdcust + no userId", async () => {
    const c = newClient();
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "list",
        data: [],
        crossdeckCustomerId: "",
        env: "production",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await c.getEntitlements();
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("anonymousId=anon_");
  });
});

describe("track + flush", () => {
  it("queues then sends a batch on flush() with the §13.1 envelope", async () => {
    const c = newClient({ eventFlushBatchSize: 100, eventFlushIntervalMs: 100_000 });
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(202, { object: "list", received: 2, env: "sandbox" }),
      );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    c.track("first");
    c.track("second", { ctaName: "trial" });
    expect(fetchSpy).toHaveBeenCalledTimes(0); // still queued
    await c.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    // Batch envelope (NorthStar §13.1)
    expect(body.appId).toBe("app_web_test");
    expect(body.environment).toBe("sandbox");
    expect(body.sdk?.name).toBe("@cross-deck/web");
    expect(typeof body.sdk?.version).toBe("string");
    // Events
    expect(body.events.length).toBe(2);
    expect(body.events[0].name).toBe("first");
    expect(body.events[1].name).toBe("second");
    expect(body.events[1].properties).toEqual(
      expect.objectContaining({ ctaName: "trial" }),
    );
    expect(body.events[0].anonymousId).toMatch(/^anon_/);
  });

  it("flushEvents() still works as a deprecated alias", async () => {
    const c = newClient({ eventFlushBatchSize: 100, eventFlushIntervalMs: 100_000 });
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(202, { object: "list", received: 1, env: "sandbox" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    c.track("legacy");
    await c.flushEvents();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("track with empty name throws synchronously", () => {
    const c = newClient();
    expect(() => c.track("")).toThrowError(CrossdeckError);
  });

  it("each event gets a unique eventId", async () => {
    const c = newClient({ eventFlushBatchSize: 100, eventFlushIntervalMs: 100_000 });
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { object: "list", received: 5, env: "sandbox" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    for (let i = 0; i < 5; i++) c.track(`e${i}`);
    await c.flush();
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string) as { events: { eventId: string }[] };
    const ids = new Set(body.events.map((e) => e.eventId));
    expect(ids.size).toBe(5);
  });
});

describe("reset", () => {
  it("wipes identity, entitlements, queued events and mints a new anonymousId", async () => {
    const c = newClient({ eventFlushBatchSize: 100, eventFlushIntervalMs: 100_000 });
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, {
          object: "alias_result",
          crossdeckCustomerId: "cdcust_x",
          linked: [],
          mergePending: false,
          env: "production",
        }),
      );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const before = c.diagnostics().anonymousId;
    await c.identify("user_001");
    c.track("evt1");
    expect(c.diagnostics().crossdeckCustomerId).toBe("cdcust_x");
    expect(c.diagnostics().events.buffered).toBe(1);

    c.reset();
    const diag = c.diagnostics();
    expect(diag.anonymousId).not.toBe(before);
    expect(diag.crossdeckCustomerId).toBeNull();
    expect(diag.developerUserId).toBeNull();
    expect(diag.events.buffered).toBe(0);
  });
});

describe("syncPurchases", () => {
  it("posts to /purchases/sync with rail+signedTransactionInfo and updates cache", async () => {
    const c = newClient();
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "purchase_result",
        crossdeckCustomerId: "cdcust_purchase_001",
        env: "sandbox",
        entitlements: [
          {
            object: "entitlement",
            key: "pro",
            isActive: true,
            validUntil: null,
            source: { rail: "apple", productId: "monthly_pro", subscriptionId: "1000" },
            updatedAt: 1700000000,
          },
        ],
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await c.syncPurchases({ signedTransactionInfo: "eyJ.test.sig" });
    expect(result.crossdeckCustomerId).toBe("cdcust_purchase_001");
    expect(c.isEntitled("pro")).toBe(true);

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/purchases/sync");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.rail).toBe("apple");
    expect(body.signedTransactionInfo).toBe("eyJ.test.sig");
  });

  it("rejects empty signedTransactionInfo", async () => {
    const c = newClient();
    await expect(c.syncPurchases({ signedTransactionInfo: "" })).rejects.toThrow(CrossdeckError);
  });

  it("purchaseApple() still works as a deprecated alias", async () => {
    const c = newClient();
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "purchase_result",
        crossdeckCustomerId: "cdcust_legacy",
        env: "sandbox",
        entitlements: [],
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await c.purchaseApple({ signedTransactionInfo: "eyJ.test" });
    expect(r.crossdeckCustomerId).toBe("cdcust_legacy");
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/purchases/sync");
  });
});

describe("setDebugMode + sensitive-property warnings", () => {
  it("does not log signals when debug is off", () => {
    const c = newClient();
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    c.track("evt", { email: "user@example.com" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("warns on sensitive property names when debug is on", () => {
    const c = newClient({ debug: true });
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    c.track("evt", { email: "user@example.com", password: "x" });
    const calls = spy.mock.calls.map((args) => String(args[0]));
    expect(calls.some((c) => c.includes("sdk.sensitive_property_warning"))).toBe(true);
    spy.mockRestore();
  });

  it("setDebugMode(true) emits the configured signal", () => {
    const c = newClient();
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    c.setDebugMode(true);
    const calls = spy.mock.calls.map((args) => String(args[0]));
    expect(calls.some((c) => c.includes("sdk.configured"))).toBe(true);
    spy.mockRestore();
  });
});

describe("diagnostics", () => {
  it("returns started:false with stable empty shape before start()", () => {
    const c = new CrossdeckClient();
    const d = c.diagnostics();
    expect(d.started).toBe(false);
    expect(d.anonymousId).toBeNull();
    expect(d.events.buffered).toBe(0);
    expect(d.entitlements.count).toBe(0);
  });
});
