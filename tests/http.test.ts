import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpClient, DEFAULT_BASE_URL } from "../src/http";
import { CrossdeckError } from "../src/errors";

describe("HttpClient", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function client() {
    return new HttpClient({
      publicKey: "cd_pub_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
    });
  }

  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  it("attaches Authorization: Bearer + Crossdeck-Sdk-Version + Accept headers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await client().request("GET", "/entitlements", { query: { userId: "u1" } });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.headers["Authorization"]).toBe("Bearer cd_pub_test_001");
    expect(init.headers["Crossdeck-Sdk-Version"]).toContain("@cross-deck/web@0.1.0-test");
    expect(init.headers["Accept"]).toBe("application/json");
  });

  it("appends query parameters with proper URL encoding", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await client().request("GET", "/entitlements", {
      query: { userId: "user 847", anonymousId: undefined, customerId: "cdcust_x" },
    });

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("userId=user+847");
    expect(url).toContain("customerId=cdcust_x");
    // Skipped — undefined values must not be serialised at all.
    expect(url).not.toContain("anonymousId=");
  });

  it("strips trailing slashes from baseUrl + ensures leading slash on path", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const c = new HttpClient({
      publicKey: "cd_pub_x",
      baseUrl: "https://api.cross-deck.com/v1///",
      sdkVersion: "0.1.0",
    });
    await c.request("GET", "noprefixslash");
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.cross-deck.com/v1/noprefixslash");
  });

  it("serialises POST body and sets Content-Type", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(202, { received: 1 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await client().request("POST", "/events", {
      body: { events: [{ name: "click" }] },
    });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ events: [{ name: "click" }] });
  });

  it("returns the parsed JSON body on success", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { object: "list", data: [] })) as unknown as typeof fetch;
    const result = await client().request<{ object: string }>("GET", "/entitlements");
    expect(result.object).toBe("list");
  });

  it("throws a typed CrossdeckError on a Stripe-style 4xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        error: {
          type: "authentication_error",
          code: "invalid_api_key",
          message: "bad key",
          request_id: "req_xyz",
        },
      }),
    ) as unknown as typeof fetch;

    await expect(client().request("GET", "/entitlements")).rejects.toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
      requestId: "req_xyz",
      status: 401,
    });
  });

  it("wraps fetch network failures as CrossdeckError(type: network_error)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;
    try {
      await client().request("GET", "/entitlements");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossdeckError);
      expect((err as CrossdeckError).type).toBe("network_error");
    }
  });

  it("returns undefined on 204 No Content", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;
    const result = await client().request("GET", "/entitlements");
    expect(result).toBeUndefined();
  });

  it("throws internal_error if a 2xx returns unparseable JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not json{{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    try {
      await client().request("GET", "/entitlements");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossdeckError);
      expect((err as CrossdeckError).code).toBe("invalid_json_response");
    }
  });

  // ----- Wave 1: abort timeout + idempotency key -----

  it("attaches Idempotency-Key header when options.idempotencyKey is set", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(202, { received: 1 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await client().request("POST", "/events", {
      body: { events: [] },
      idempotencyKey: "batch_abc123",
    });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBe("batch_abc123");
  });

  it("omits Idempotency-Key when not supplied", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await client().request("GET", "/entitlements");
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("aborts the fetch after timeoutMs and surfaces request_timeout", async () => {
    // Mock fetch that respects the abort signal — resolves only when not aborted.
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const c = new HttpClient({
      publicKey: "cd_pub_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
      timeoutMs: 50,
    });

    try {
      await c.request("GET", "/entitlements");
      expect.fail("expected timeout throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossdeckError);
      expect((err as CrossdeckError).type).toBe("network_error");
      expect((err as CrossdeckError).code).toBe("request_timeout");
    }
  });

  it("per-call timeoutMs overrides client default", async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;

    const c = new HttpClient({
      publicKey: "cd_pub_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
      timeoutMs: 10_000, // would never fire in test time
    });

    const start = Date.now();
    try {
      await c.request("GET", "/entitlements", { timeoutMs: 30 });
      expect.fail("expected timeout throw");
    } catch (err) {
      expect(Date.now() - start).toBeLessThan(500);
      expect((err as CrossdeckError).code).toBe("request_timeout");
    }
  });

  it("timeoutMs: 0 disables the timeout (resolves normally)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await client().request("GET", "/entitlements", { timeoutMs: 0 });
    expect(result).toEqual({ ok: true });
    // No abort signal should have been attached.
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeUndefined();
  });

  it("exposes Retry-After header (delta-seconds) on 429 errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { type: "rate_limit_error", code: "rate_limited", message: "slow" },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "30",
          },
        },
      ),
    ) as unknown as typeof fetch;

    try {
      await client().request("GET", "/entitlements");
      expect.fail("expected throw");
    } catch (err) {
      expect((err as CrossdeckError).type).toBe("rate_limit_error");
      expect((err as CrossdeckError).retryAfterMs).toBe(30_000);
    }
  });
});
