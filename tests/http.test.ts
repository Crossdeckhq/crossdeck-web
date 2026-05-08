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
});
