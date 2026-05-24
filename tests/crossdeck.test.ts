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

  it("clears the entitlement cache when a DIFFERENT user identifies on the same device", async () => {
    // Existing semantic — the obvious cross-customer leak guard.
    const c = newClient();
    globalThis.fetch = vi
      .fn()
      // First identify resolves to cdcust_A
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "alias_result",
          crossdeckCustomerId: "cdcust_A",
          linked: [],
          mergePending: false,
          env: "production",
        }),
      )
      // First getEntitlements warms cache with cdcust_A's pro entitlement
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "list",
          data: [
            {
              object: "entitlement",
              key: "pro",
              isActive: true,
              validUntil: null,
              source: { rail: "stripe", productId: "p", subscriptionId: "s" },
              updatedAt: 1700000000,
            },
          ],
          crossdeckCustomerId: "cdcust_A",
          env: "production",
        }),
      )
      // Second identify resolves to cdcust_B (different user logs in)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          object: "alias_result",
          crossdeckCustomerId: "cdcust_B",
          linked: [],
          mergePending: false,
          env: "production",
        }),
      ) as unknown as typeof fetch;
    await c.identify("user_A");
    await c.getEntitlements();
    expect(c.isEntitled("pro")).toBe(true);
    await c.identify("user_B");
    // Cache cleared — cdcust_A's pro entitlement must NOT leak to user_B.
    expect(c.isEntitled("pro")).toBe(false);
    expect(c.listEntitlements()).toEqual([]);
  });

  it("clears the entitlement cache when priorCdcust is null but cache has entries (P0 #5 regression)", async () => {
    // Audit scenario: cdcust was wiped by ITP / cookie eviction / partial
    // localStorage clear but the entitlement cache survived under
    // different storage semantics (different TTLs). Pre-fix the clear
    // was gated on `priorCdcust && ...`, so this NULL prior path skipped
    // the clear and the new user inherited the previous user's
    // entitlements until the next getEntitlements() round-trip
    // completed — a real cross-customer leak.
    const storage = new MemoryStorage();
    // Pre-populate the entitlement cache WITHOUT a cdcust (simulating
    // the partial wipe — entitlements survived, identity didn't).
    storage.setItem(
      "crossdeck:entitlements",
      JSON.stringify({
        v: 1,
        entitlements: [
          {
            object: "entitlement",
            key: "pro",
            isActive: true,
            validUntil: null,
            source: { rail: "stripe", productId: "p_prior", subscriptionId: "s_prior" },
            updatedAt: 1700000000,
          },
        ],
        lastUpdated: 1700000000,
      }),
    );
    const c = new CrossdeckClient();
    c.init({
      appId: "app_web_test",
      publicKey: "cd_pub_test_001",
      environment: "sandbox",
      storage,
      autoHeartbeat: false,
    });
    // Pre-identify: cache rehydrated, cdcust is null.
    expect(c.isEntitled("pro")).toBe(true);
    expect(c.diagnostics().crossdeckCustomerId).toBeNull();

    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "alias_result",
        crossdeckCustomerId: "cdcust_new_user",
        linked: [],
        mergePending: false,
        env: "production",
      }),
    ) as unknown as typeof fetch;
    await c.identify("user_new");
    // The new user identified — prior cache must be cleared, not
    // silently inherited.
    expect(c.isEntitled("pro")).toBe(false);
    expect(c.listEntitlements()).toEqual([]);
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

  it("explicit rail: undefined still defaults to apple (P1 #15 spread-order bug regression)", async () => {
    // Pre-fix `{ rail: input.rail ?? "apple", ...input }` — the
    // `...input` spread runs LAST and overrides the default when the
    // caller passes `rail: undefined` explicitly (TypeScript treats
    // an undefined-typed property as "key present"). New order
    // `{ ...input, rail }` puts the default last so it wins.
    const c = newClient();
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "purchase_result",
        crossdeckCustomerId: "cdcust_x",
        env: "sandbox",
        entitlements: [],
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await c.syncPurchases({
      rail: undefined as unknown as "apple",
      signedTransactionInfo: "eyJ.test.sig",
    });
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.rail).toBe("apple"); // pre-fix this was `undefined`
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

describe("identify(userId, { traits }) — v0.9.0+", () => {
  it("sends traits in the alias body when provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "alias_result",
        crossdeckCustomerId: "cdcust_x",
        linked: [],
        mergePending: false,
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient();
    await c.identify("user_847", {
      email: "wes@pinet.co.za",
      traits: { name: "Wes", plan: "pro" },
    });
    const aliasCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/identity/alias"),
    );
    expect(aliasCall).toBeDefined();
    const body = JSON.parse((aliasCall![1] as RequestInit).body as string);
    expect(body.userId).toBe("user_847");
    expect(body.email).toBe("wes@pinet.co.za");
    expect(body.traits).toEqual({ name: "Wes", plan: "pro" });
  });

  it("omits traits when an empty object is supplied", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "alias_result",
        crossdeckCustomerId: "cdcust_x",
        linked: [],
        mergePending: false,
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient();
    await c.identify("user_847", { traits: {} });
    const aliasCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/identity/alias"),
    );
    const body = JSON.parse((aliasCall![1] as RequestInit).body as string);
    expect(body.traits).toBeUndefined();
  });

  it("sanitises traits — functions / BigInt coerced or dropped", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "alias_result",
        crossdeckCustomerId: "cdcust_x",
        linked: [],
        mergePending: false,
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient();
    await c.identify("user_847", {
      traits: {
        plan: "pro",
        save: () => 0, // dropped
        bigNumber: 1n, // coerced to string
      },
    });
    const aliasCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/identity/alias"),
    );
    const body = JSON.parse((aliasCall![1] as RequestInit).body as string);
    expect(body.traits.plan).toBe("pro");
    expect(body.traits.save).toBeUndefined();
    expect(body.traits.bigNumber).toBe("1");
  });
});

describe("register / unregister / group", () => {
  it("register() attaches super-properties to every subsequent event", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { object: "list", received: 1, env: "sandbox" }));

    const c = newClient();
    c.register({ plan: "pro", releaseChannel: "beta" });
    c.track("paywall_shown");
    await c.flush();
    const eventsCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    expect(body.events[0].properties.plan).toBe("pro");
    expect(body.events[0].properties.releaseChannel).toBe("beta");
  });

  it("unregister() removes a super-property", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { object: "list", received: 1, env: "sandbox" }));

    const c = newClient();
    c.register({ plan: "pro" });
    c.unregister("plan");
    c.track("paywall_shown");
    await c.flush();
    const eventsCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    expect(body.events[0].properties.plan).toBeUndefined();
  });

  it("caller-supplied properties override super-properties", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { object: "list", received: 1, env: "sandbox" }));

    const c = newClient();
    c.register({ plan: "pro" });
    c.track("paywall_shown", { plan: "enterprise" });
    await c.flush();
    const eventsCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    expect(body.events[0].properties.plan).toBe("enterprise");
  });

  it("group() attaches $groups.<type>: id to every event", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { object: "list", received: 1, env: "sandbox" }));

    const c = newClient();
    c.group("org", "acme_inc");
    c.group("team", "design", { headcount: 12 });
    c.track("paywall_shown");
    await c.flush();
    const eventsCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    expect(body.events[0].properties.$groups).toEqual({ org: "acme_inc", team: "design" });
  });

  it("group(type, null) clears that group", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { object: "list", received: 1, env: "sandbox" }));

    const c = newClient();
    c.group("org", "acme_inc");
    c.group("org", null);
    c.track("paywall_shown");
    await c.flush();
    const eventsCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    expect(body.events[0].properties.$groups).toBeUndefined();
  });

  it("reset() clears super-properties and groups", async () => {
    const c = newClient();
    c.register({ plan: "pro" });
    c.group("org", "acme");
    c.reset();
    expect(c.getSuperProperties()).toEqual({});
    expect(c.getGroups()).toEqual({});
  });
});

describe("consent gating — v0.10.0+", () => {
  it("track() drops events silently when analytics consent is denied", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(202, { received: 0 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient();
    c.consent({ analytics: false });
    c.track("paywall_shown");
    await c.flush();
    const eventsCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/events"),
    );
    expect(eventsCalls.length).toBe(0);
  });

  it("track() still fires when analytics consent is granted", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(202, { received: 1 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient();
    c.consent({ analytics: true, marketing: false });
    c.track("paywall_shown");
    await c.flush();
    const eventsCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/events"),
    );
    expect(eventsCalls.length).toBe(1);
  });

  it("webvitals.* events gate on the errors dimension, not analytics", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(202, { received: 1 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient();
    c.consent({ analytics: false, errors: true });
    c.track("webvitals.lcp", { valueMs: 1200 });
    await c.flush();
    const eventsCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/events"),
    );
    expect(eventsCalls.length).toBe(1);
  });

  it("identify() short-circuits to a no-op result when analytics denied", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient();
    c.consent({ analytics: false });
    const result = await c.identify("user_847");
    expect(result.crossdeckCustomerId).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("consentStatus() returns the current state", () => {
    const c = newClient();
    expect(c.consentStatus()).toEqual({ analytics: true, marketing: true, errors: true });
    c.consent({ marketing: false });
    expect(c.consentStatus()).toEqual({ analytics: true, marketing: false, errors: true });
  });
});

describe("PII scrubbing — v0.10.0+", () => {
  it("scrubs emails from URL properties before flush", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(202, { received: 1 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient();
    c.track("page_viewed_custom", {
      url: "/users/wes@pinet.co.za/edit",
      title: "Edit wes@pinet.co.za",
    });
    await c.flush();
    const eventsCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("/events"));
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    expect(body.events[0].properties.url).toBe("/users/<email>/edit");
    expect(body.events[0].properties.title).toBe("Edit <email>");
  });

  it("scrubPii: false in init disables the redaction", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(202, { received: 1 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient({ scrubPii: false });
    c.track("page_viewed_custom", { url: "/users/wes@pinet.co.za/edit" });
    await c.flush();
    const eventsCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("/events"));
    const body = JSON.parse((eventsCall![1] as RequestInit).body as string);
    expect(body.events[0].properties.url).toBe("/users/wes@pinet.co.za/edit");
  });
});

describe("forget() — v0.10.0+", () => {
  it("calls /v1/identity/forget then wipes local state", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { object: "forgot" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = newClient();
    c.register({ plan: "pro" });
    await c.forget();
    const forgetCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("/identity/forget"),
    );
    expect(forgetCall).toBeDefined();
    expect(c.getSuperProperties()).toEqual({});
  });

  it("server-side failure still wipes local state", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "internal_error", code: "boom", message: "oops" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const c = newClient();
    c.register({ plan: "pro" });
    await c.forget();
    // The right-to-be-forgotten request to our server failed, but the
    // user's device must still be wiped — that's the contract.
    expect(c.getSuperProperties()).toEqual({});
  });
});

describe("error capture — v1.0.0+", () => {
  it("captureError() ships an error.handled event with stack + fingerprint", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { object: "list", received: 1, env: "sandbox" }));

    const c = newClient();
    const err = new Error("boom");
    c.captureError(err, { tags: { flow: "checkout" }, context: { cart: { items: 3 } } });
    await c.flush();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const errEv = body.events.find((e: { name: string }) => e.name === "error.handled");
    expect(errEv).toBeTruthy();
    expect(errEv.properties.message).toBe("boom");
    expect(errEv.properties.errorType).toBe("Error");
    expect(errEv.properties.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(errEv.properties.tags).toEqual({ flow: "checkout" });
    expect(errEv.properties.context).toEqual({ cart: { items: 3 } });
  });

  it("captureMessage() emits error.message with the right level", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { received: 1 }));
    const c = newClient();
    c.captureMessage("hit the deprecated path", "warning");
    await c.flush();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const msgEv = body.events.find((e: { name: string }) => e.name === "error.message");
    expect(msgEv).toBeTruthy();
    expect(msgEv.properties.level).toBe("warning");
  });

  it("setTag() and setContext() attach to every subsequent error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { received: 1 }));
    const c = newClient();
    c.setTag("release", "v0.10.0-test");
    c.setContext("session", { plan: "pro" });
    c.captureError(new Error("first"));
    c.captureError(new Error("second"));
    await c.flush();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const errors = body.events.filter((e: { name: string }) => e.name === "error.handled");
    expect(errors).toHaveLength(2);
    for (const ev of errors) {
      expect(ev.properties.tags.release).toBe("v0.10.0-test");
      expect(ev.properties.context.session).toEqual({ plan: "pro" });
    }
  });

  it("addBreadcrumb() attaches custom crumbs to subsequent errors", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { received: 1 }));
    const c = newClient();
    c.addBreadcrumb({
      timestamp: Date.now(),
      category: "custom",
      message: "user-opened-paywall",
    });
    c.captureError(new Error("paywall-crash"));
    await c.flush();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const errEv = body.events.find((e: { name: string }) => e.name === "error.handled");
    expect(errEv.properties.breadcrumbs.some((c: { message: string }) => c.message === "user-opened-paywall"))
      .toBe(true);
  });

  it("auto-emits breadcrumbs from track() calls", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { received: 1 }));
    const c = newClient();
    c.track("paywall_viewed", { variant: "v3" });
    c.captureError(new Error("after-paywall"));
    await c.flush();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const errEv = body.events.find((e: { name: string }) => e.name === "error.handled");
    expect(errEv.properties.breadcrumbs.some((c: { message: string }) => c.message === "paywall_viewed"))
      .toBe(true);
  });

  it("consent({ errors: false }) drops error events", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { received: 1 }));
    const c = newClient();
    c.consent({ errors: false });
    c.captureError(new Error("should-not-ship"));
    await c.flush();
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).includes("/events"),
    );
    for (const call of calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      const errors = body.events.filter((e: { name: string }) => e.name.startsWith("error."));
      expect(errors).toHaveLength(0);
    }
  });

  it("setErrorBeforeSend installed AFTER init() fires on the next captured error (P0 #3)", async () => {
    // Regression: previously the ErrorTracker captured `beforeSend` by
    // value at construction, so any hook installed after init() was
    // silently inert — the customer's PII scrubber ran on zero errors.
    // The contract is now a getter that resolves on every report.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { received: 1 }));
    const c = newClient();
    let invoked = 0;
    c.setErrorBeforeSend((err) => {
      invoked += 1;
      return { ...err, message: "[scrubbed]" };
    });
    c.captureError(new Error("token=abc123"));
    await c.flush();
    expect(invoked).toBe(1);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const errEv = body.events.find((e: { name: string }) => e.name === "error.handled");
    expect(errEv.properties.message).toBe("[scrubbed]");
  });

  it("setErrorBeforeSend(null) clears a previously-installed hook", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { received: 1 }));
    const c = newClient();
    c.setErrorBeforeSend(() => null);
    c.setErrorBeforeSend(null); // explicit clear
    c.captureError(new Error("must-ship"));
    await c.flush();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const errEv = body.events.find((e: { name: string }) => e.name === "error.handled");
    expect(errEv).toBeTruthy();
    expect(errEv.properties.message).toBe("must-ship");
  });

  it("reset() wipes breadcrumbs + error context", async () => {
    const c = newClient();
    c.setTag("flow", "checkout");
    c.addBreadcrumb({ timestamp: 1, category: "custom", message: "x" });
    c.reset();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { received: 1 }));
    c.captureError(new Error("after-reset"));
    await c.flush();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/events"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const errEv = body.events.find((e: { name: string }) => e.name === "error.handled");
    expect(errEv.properties.tags).toEqual({});
    expect(errEv.properties.context).toEqual({});
    // Breadcrumbs should not contain the pre-reset "x" entry.
    expect(errEv.properties.breadcrumbs.find((c: { message: string }) => c.message === "x")).toBeUndefined();
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

  it("exposes the Wave-1 diagnostic surface (retry counters + listenerErrors + clock skew)", () => {
    const c = new CrossdeckClient();
    const d = c.diagnostics();
    expect(d.events.consecutiveFailures).toBe(0);
    expect(d.events.nextRetryAt).toBeNull();
    expect(d.entitlements.listenerErrors).toBe(0);
    expect(d.clock).toEqual({
      lastServerTime: null,
      lastClientTime: null,
      skewMs: null,
    });
  });

  it("reset() nulls clock-skew snapshot so diagnostics() doesn't echo prior session (P1 #17 regression)", async () => {
    // Pre-fix `state.lastServerTime` / `lastClientTime` survived
    // logout, so `diagnostics().clock.skewMs` for the next user kept
    // reporting the prior session's skew until the next heartbeat
    // rewrote them. New contract: reset() nulls both.
    const c = newClient();
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        object: "heartbeat",
        ok: true,
        projectId: "proj_x",
        appId: "app_web_test",
        platform: "web",
        env: "sandbox",
        serverTime: 1_700_000_000_000,
      }),
    ) as unknown as typeof fetch;
    await c.heartbeat();
    expect(c.diagnostics().clock.lastServerTime).toBe(1_700_000_000_000);
    expect(c.diagnostics().clock.lastClientTime).not.toBeNull();

    c.reset();
    expect(c.diagnostics().clock.lastServerTime).toBeNull();
    expect(c.diagnostics().clock.lastClientTime).toBeNull();
    expect(c.diagnostics().clock.skewMs).toBeNull();
  });
});
