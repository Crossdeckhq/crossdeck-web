import { describe, it, expect } from "vitest";
import {
  CrossdeckError,
  crossdeckErrorFromResponse,
  parseRetryAfterHeader,
} from "../src/errors";

describe("CrossdeckError", () => {
  it("preserves all payload fields", () => {
    const err = new CrossdeckError({
      type: "authentication_error",
      code: "invalid_api_key",
      message: "Unknown publishable key.",
      requestId: "req_abc",
      status: 401,
    });
    expect(err.type).toBe("authentication_error");
    expect(err.code).toBe("invalid_api_key");
    expect(err.message).toBe("Unknown publishable key.");
    expect(err.requestId).toBe("req_abc");
    expect(err.status).toBe(401);
    expect(err.name).toBe("CrossdeckError");
  });

  it("is a real Error subclass (instanceof works)", () => {
    const err = new CrossdeckError({
      type: "internal_error",
      code: "boom",
      message: "explosion",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CrossdeckError);
  });
});

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Headers(headers);
  return {
    status,
    statusText: status === 401 ? "Unauthorized" : "",
    ok: status >= 200 && status < 300,
    headers: h,
    json: async () => body,
    text: async () => JSON.stringify(body),
    url: "test://",
    redirected: false,
    type: "default" as const,
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    clone() {
      return this;
    },
  } as unknown as Response;
}

describe("crossdeckErrorFromResponse", () => {
  it("parses Stripe-style envelope and copies all fields", async () => {
    const res = fakeResponse(401, {
      error: {
        type: "authentication_error",
        code: "invalid_api_key",
        message: "Unknown key.",
        request_id: "req_abc",
      },
    });
    const err = await crossdeckErrorFromResponse(res);
    expect(err.type).toBe("authentication_error");
    expect(err.code).toBe("invalid_api_key");
    expect(err.message).toBe("Unknown key.");
    expect(err.requestId).toBe("req_abc");
    expect(err.status).toBe(401);
  });

  it("falls back to header request_id when not in body", async () => {
    const res = fakeResponse(
      400,
      {
        error: {
          type: "invalid_request_error",
          code: "missing_customer",
          message: "missing",
        },
      },
      { "x-request-id": "req_header_only" },
    );
    const err = await crossdeckErrorFromResponse(res);
    expect(err.requestId).toBe("req_header_only");
  });

  it("status-mapped fallback when body isn't an error envelope", async () => {
    const res = fakeResponse(429, { unrelated: "body" });
    const err = await crossdeckErrorFromResponse(res);
    expect(err.type).toBe("rate_limit_error");
    expect(err.status).toBe(429);
  });

  it.each([
    [401, "authentication_error"],
    [403, "permission_error"],
    [429, "rate_limit_error"],
    [400, "invalid_request_error"],
    [404, "invalid_request_error"],
    [500, "internal_error"],
    [502, "internal_error"],
    [503, "internal_error"],
  ] as const)("status %i → %s (fallback type mapping)", async (status, expected) => {
    const res = fakeResponse(status, null);
    const err = await crossdeckErrorFromResponse(res);
    expect(err.type).toBe(expected);
  });

  it("handles non-JSON bodies gracefully", async () => {
    const broken = {
      status: 500,
      statusText: "",
      ok: false,
      headers: new Headers(),
      json: async () => {
        throw new Error("Invalid JSON");
      },
    } as unknown as Response;
    const err = await crossdeckErrorFromResponse(broken);
    expect(err.type).toBe("internal_error");
    expect(err.code).toBe("http_500");
  });

  it("parses Retry-After (delta-seconds) onto retryAfterMs", async () => {
    const res = fakeResponse(429, null, { "Retry-After": "45" });
    const err = await crossdeckErrorFromResponse(res);
    expect(err.retryAfterMs).toBe(45_000);
  });

  it("parses Retry-After (HTTP-date) onto retryAfterMs", async () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const res = fakeResponse(503, null, { "Retry-After": future });
    const err = await crossdeckErrorFromResponse(res);
    expect(err.retryAfterMs).toBeGreaterThan(8_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it("retryAfterMs is undefined when header is absent", async () => {
    const res = fakeResponse(429, null);
    const err = await crossdeckErrorFromResponse(res);
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe("parseRetryAfterHeader", () => {
  it("returns undefined for null / empty", () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader("")).toBeUndefined();
    expect(parseRetryAfterHeader("   ")).toBeUndefined();
  });

  it("parses delta-seconds (integer)", () => {
    expect(parseRetryAfterHeader("0")).toBe(0);
    expect(parseRetryAfterHeader("1")).toBe(1000);
    expect(parseRetryAfterHeader("120")).toBe(120_000);
  });

  it("parses delta-seconds (decimal)", () => {
    expect(parseRetryAfterHeader("1.5")).toBe(1500);
  });

  it("parses HTTP-date", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfterHeader(future);
    expect(ms).toBeGreaterThan(3_000);
    expect(ms).toBeLessThanOrEqual(5_000);
  });

  it("clamps past HTTP-date to 0", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfterHeader(past)).toBe(0);
  });

  it("returns undefined for malformed input", () => {
    expect(parseRetryAfterHeader("nonsense")).toBeUndefined();
    expect(parseRetryAfterHeader("-5")).toBeUndefined();
  });
});
