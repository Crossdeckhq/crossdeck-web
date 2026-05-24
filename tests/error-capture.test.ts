import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorTracker, DEFAULT_ERROR_CAPTURE, extractSelfHostname, isSelfRequest } from "../src/error-capture";
import { BreadcrumbBuffer } from "../src/breadcrumbs";
import type { CapturedError, ErrorCaptureConfig } from "../src/error-capture";

function newTracker(overrides: Partial<ErrorCaptureConfig> = {}) {
  const reports: CapturedError[] = [];
  const tracker = new ErrorTracker({
    config: { ...DEFAULT_ERROR_CAPTURE, ...overrides },
    breadcrumbs: new BreadcrumbBuffer(),
    report: (err) => reports.push(err),
    getContext: () => ({}),
    getTags: () => ({}),
    isConsented: () => true,
  });
  return { tracker, reports };
}

describe("ErrorTracker — captureError()", () => {
  it("captures a real Error with parsed stack", () => {
    const { tracker, reports } = newTracker();
    const err = new Error("boom");
    tracker.captureError(err);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toBe("boom");
    expect(reports[0]!.errorType).toBe("Error");
    expect(reports[0]!.kind).toBe("error.handled");
    expect(reports[0]!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("captures a non-Error throw (string)", () => {
    const { tracker, reports } = newTracker();
    tracker.captureError("just a string");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toContain("just a string");
    expect(reports[0]!.errorType).toBeNull();
  });

  it("merges context + tags from captureError options", () => {
    const { tracker, reports } = newTracker();
    tracker.captureError(new Error("x"), {
      context: { cart: { items: 3 } },
      tags: { flow: "checkout" },
    });
    expect(reports[0]!.context.cart).toEqual({ items: 3 });
    expect(reports[0]!.tags.flow).toBe("checkout");
  });

  it("never throws on a buggy unknown input", () => {
    const { tracker } = newTracker();
    const weird: unknown = { toString: () => { throw new Error("nope"); } };
    expect(() => tracker.captureError(weird)).not.toThrow();
  });

  it("skips capture when consent.errors is denied", () => {
    const reports: CapturedError[] = [];
    let consented = false;
    const tracker = new ErrorTracker({
      config: DEFAULT_ERROR_CAPTURE,
      breadcrumbs: new BreadcrumbBuffer(),
      report: (err) => reports.push(err),
      getContext: () => ({}),
      getTags: () => ({}),
      isConsented: () => consented,
    });
    tracker.captureError(new Error("x"));
    expect(reports).toHaveLength(0);
    consented = true;
    tracker.captureError(new Error("y"));
    expect(reports).toHaveLength(1);
  });
});

describe("ErrorTracker — captureMessage()", () => {
  it("emits error.message with the given level", () => {
    const { tracker, reports } = newTracker();
    tracker.captureMessage("deprecated path hit", "warning");
    expect(reports[0]!.kind).toBe("error.message");
    expect(reports[0]!.level).toBe("warning");
    expect(reports[0]!.message).toBe("deprecated path hit");
  });
});

describe("ErrorTracker — filtering", () => {
  it("respects ignoreErrors (string)", () => {
    const { tracker, reports } = newTracker({
      ignoreErrors: ["specific noise"],
    });
    tracker.captureError(new Error("specific noise pattern"));
    tracker.captureError(new Error("a real bug"));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toContain("real bug");
  });

  it("respects ignoreErrors (RegExp)", () => {
    const { tracker, reports } = newTracker({
      ignoreErrors: [/ResizeObserver/],
    });
    tracker.captureError(new Error("ResizeObserver loop"));
    tracker.captureError(new Error("real"));
    expect(reports.map((r) => r.message)).toEqual(["real"]);
  });

  it("respects denyUrls", () => {
    const { tracker, reports } = newTracker({
      denyUrls: [/extension/],
    });
    const err = new Error("from extension");
    err.stack = "Error: from extension\n    at fn (chrome-extension://abc/x.js:1:1)";
    tracker.captureError(err);
    expect(reports).toHaveLength(0);
  });

  it("default config drops ResizeObserver browser noise", () => {
    const { tracker, reports } = newTracker();
    tracker.captureError(new Error("ResizeObserver loop limit exceeded"));
    tracker.captureError(
      new Error("ResizeObserver loop completed with undelivered notifications"),
    );
    expect(reports).toHaveLength(0);
  });

  it("default config NO LONGER drops Script error. — captured with label", () => {
    // We used to silently swallow these. Now we surface them with a
    // recognisable message so the developer can fix the CORS config.
    const { tracker, reports } = newTracker();
    tracker.captureError(new Error("Script error."));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toBe("Script error.");
  });
});

describe("ErrorTracker — non-Error payload coercion", () => {
  it("captures a plain object with constructor name and message field", () => {
    const { tracker, reports } = newTracker();
    class MyApiError {
      readonly code = 500;
      readonly message = "server fell over";
    }
    tracker.captureError(new MyApiError());
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toBe("server fell over");
    expect(reports[0]!.errorType).toBe("MyApiError");
    expect((reports[0]!.context as Record<string, unknown>).__error_extras).toMatchObject({
      code: 500,
    });
  });

  it("captures a plain object with no message field — uses constructor name", () => {
    const { tracker, reports } = newTracker();
    tracker.captureError({ code: 418, details: "teapot" });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toContain("418");
    expect((reports[0]!.context as Record<string, unknown>).__error_extras).toMatchObject({
      code: 418,
      details: "teapot",
    });
  });

  it("captures null and undefined throws explicitly (no Unknown error)", () => {
    const { tracker, reports } = newTracker();
    tracker.captureError(null);
    tracker.captureError(undefined);
    expect(reports).toHaveLength(2);
    expect(reports[0]!.message).toBe("(thrown: null)");
    expect(reports[1]!.message).toBe("(thrown: undefined)");
  });

  it("captures Error.cause chain into extras", () => {
    const { tracker, reports } = newTracker();
    const root = new Error("dns lookup failed");
    // Construct the cause chain manually rather than using the ES2022
    // `new Error(msg, { cause })` syntax — the SDK ships with ES2020
    // lib target, so the test must avoid the newer constructor form.
    // The runtime field is what the SDK reads (collectCauseChain).
    const wrapper = new Error("upstream timeout");
    (wrapper as Error & { cause: unknown }).cause = root;
    tracker.captureError(wrapper);
    const extras = (reports[0]!.context as Record<string, unknown>).__error_extras as {
      cause: Array<{ name: string; message: string }>;
    };
    expect(extras.cause).toEqual([{ name: "Error", message: "dns lookup failed" }]);
  });

  it("captures own properties on a custom Error subclass", () => {
    const { tracker, reports } = newTracker();
    class HttpError extends Error {
      readonly status: number;
      readonly url: string;
      constructor(status: number, url: string) {
        super(`HTTP ${status}`);
        this.name = "HttpError";
        this.status = status;
        this.url = url;
      }
    }
    tracker.captureError(new HttpError(503, "https://x.example/api"));
    expect(reports[0]!.errorType).toBe("HttpError");
    expect((reports[0]!.context as Record<string, unknown>).__error_extras).toMatchObject({
      status: 503,
      url: "https://x.example/api",
    });
  });

  it("two non-Error throws at different shapes get DIFFERENT fingerprints", () => {
    // Regression: the old code collapsed every non-Error throw under
    // a single "Unknown error" fingerprint.
    const { tracker, reports } = newTracker();
    tracker.captureError({ code: 500, where: "a" });
    tracker.captureError({ code: 500, where: "b" });
    expect(reports).toHaveLength(2);
    expect(reports[0]!.fingerprint).not.toBe(reports[1]!.fingerprint);
  });
});

describe("ErrorTracker — rate limiting", () => {
  it("caps per-fingerprint reports per minute", () => {
    const { tracker, reports } = newTracker({
      maxPerFingerprintPerMinute: 2,
    });
    // Reuse one Error so stack-derived fingerprint is identical.
    const err = new Error("same");
    for (let i = 0; i < 10; i++) {
      tracker.captureError(err);
    }
    expect(reports).toHaveLength(2);
  });

  it("different fingerprints share the same minute window separately", () => {
    const { tracker, reports } = newTracker({
      maxPerFingerprintPerMinute: 1,
    });
    // Reuse the SAME error instance for the first two calls so their
    // fingerprints (which include the top stack frame) are identical.
    const errA = new Error("a");
    tracker.captureError(errA);
    tracker.captureError(errA); // rate-limited — same fingerprint
    tracker.captureError(new Error("b")); // different fingerprint, allowed
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.message)).toEqual(["a", "b"]);
  });

  it("hard cap per session blocks runaway reporting", () => {
    const { tracker, reports } = newTracker({
      maxPerSession: 3,
      maxPerFingerprintPerMinute: 1000,
    });
    for (let i = 0; i < 10; i++) {
      tracker.captureError(new Error(`distinct ${i}`));
    }
    expect(reports).toHaveLength(3);
  });
});

describe("ErrorTracker — sampling", () => {
  it("sampleRate 0 sends nothing", () => {
    const { tracker, reports } = newTracker({ sampleRate: 0 });
    for (let i = 0; i < 20; i++) tracker.captureError(new Error(`x ${i}`));
    expect(reports).toHaveLength(0);
  });

  it("sampleRate 1 sends everything", () => {
    const { tracker, reports } = newTracker({
      sampleRate: 1,
      maxPerFingerprintPerMinute: 1000,
    });
    for (let i = 0; i < 20; i++) tracker.captureError(new Error(`x ${i}`));
    expect(reports).toHaveLength(20);
  });
});

describe("ErrorTracker — beforeSend hook", () => {
  it("calls beforeSend on every passing error", () => {
    const seen: string[] = [];
    const reports: CapturedError[] = [];
    const tracker = new ErrorTracker({
      config: DEFAULT_ERROR_CAPTURE,
      breadcrumbs: new BreadcrumbBuffer(),
      report: (err) => reports.push(err),
      getContext: () => ({}),
      getTags: () => ({}),
      isConsented: () => true,
      beforeSend: () => (err) => {
        seen.push(err.message);
        return err;
      },
    });
    tracker.captureError(new Error("a"));
    expect(seen).toEqual(["a"]);
  });

  it("returning null drops the error", () => {
    const reports: CapturedError[] = [];
    const tracker = new ErrorTracker({
      config: DEFAULT_ERROR_CAPTURE,
      breadcrumbs: new BreadcrumbBuffer(),
      report: (err) => reports.push(err),
      getContext: () => ({}),
      getTags: () => ({}),
      isConsented: () => true,
      beforeSend: () => () => null,
    });
    tracker.captureError(new Error("dropped"));
    expect(reports).toHaveLength(0);
  });

  it("a throwing beforeSend falls back to the original error (never drops)", () => {
    const reports: CapturedError[] = [];
    const tracker = new ErrorTracker({
      config: DEFAULT_ERROR_CAPTURE,
      breadcrumbs: new BreadcrumbBuffer(),
      report: (err) => reports.push(err),
      getContext: () => ({}),
      getTags: () => ({}),
      isConsented: () => true,
      beforeSend: () => () => { throw new Error("buggy hook"); },
    });
    tracker.captureError(new Error("real bug"));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toBe("real bug");
  });
});

describe("ErrorTracker — context + tags", () => {
  it("attaches the live context + tags snapshot at capture time", () => {
    const reports: CapturedError[] = [];
    const tagsBag: Record<string, string> = { flow: "boot" };
    const contextBag: Record<string, unknown> = { plan: "pro" };
    const tracker = new ErrorTracker({
      config: DEFAULT_ERROR_CAPTURE,
      breadcrumbs: new BreadcrumbBuffer(),
      report: (err) => reports.push(err),
      getContext: () => ({ ...contextBag }),
      getTags: () => ({ ...tagsBag }),
      isConsented: () => true,
    });
    tracker.captureError(new Error("x"));
    expect(reports[0]!.tags.flow).toBe("boot");
    expect(reports[0]!.context.plan).toBe("pro");

    // Mutate context and capture again — should reflect.
    tagsBag.flow = "checkout";
    contextBag.plan = "enterprise";
    tracker.captureError(new Error("y"));
    expect(reports[1]!.tags.flow).toBe("checkout");
    expect(reports[1]!.context.plan).toBe("enterprise");
  });
});

describe("ErrorTracker — breadcrumb attachment", () => {
  it("snapshots breadcrumbs at capture time", () => {
    const crumbs = new BreadcrumbBuffer();
    crumbs.add({ timestamp: 1, category: "ui.click", message: "clicked-buy" });
    crumbs.add({ timestamp: 2, category: "navigation", message: "page.viewed" });
    const reports: CapturedError[] = [];
    const tracker = new ErrorTracker({
      config: DEFAULT_ERROR_CAPTURE,
      breadcrumbs: crumbs,
      report: (err) => reports.push(err),
      getContext: () => ({}),
      getTags: () => ({}),
      isConsented: () => true,
    });
    tracker.captureError(new Error("x"));
    expect(reports[0]!.breadcrumbs).toHaveLength(2);
    expect(reports[0]!.breadcrumbs[0]!.message).toBe("clicked-buy");
  });
});

// ============================================================
// Self-skip URL matching (P0 #7) — unit tests for the pure
// extractSelfHostname() + isSelfRequest() helpers used by the
// fetch / XHR wraps to skip captureHttp on Crossdeck's own
// requests. The wrap-firing integration is covered end-to-end
// by sdks/node/tests/error-capture.test.ts (same code shape on
// web; pure-function unit tests below are environment-agnostic
// and exhaustive on the matching logic that pre-fix was a
// `url.includes("api.cross-deck.com")` hardcode).
// ============================================================

describe("extractSelfHostname (P0 #7)", () => {
  it("returns the lowercased hostname from a https URL", () => {
    expect(extractSelfHostname("https://api.cross-deck.com/v1")).toBe("api.cross-deck.com");
  });

  it("lowercases mixed-case hostnames", () => {
    expect(extractSelfHostname("https://API.Cross-Deck.COM/v1")).toBe("api.cross-deck.com");
  });

  it("works with a custom baseUrl (regional / staging / self-hosted relay)", () => {
    expect(extractSelfHostname("https://crossdeck-eu.customer.example/v1")).toBe(
      "crossdeck-eu.customer.example",
    );
    expect(extractSelfHostname("https://api-staging.cross-deck.com/v1")).toBe(
      "api-staging.cross-deck.com",
    );
  });

  it("works with http (localhost emulator paths)", () => {
    expect(extractSelfHostname("http://localhost:5001/crossdeck-47d8f/us-east4/v1")).toBe("localhost");
  });

  it("returns null on malformed input", () => {
    expect(extractSelfHostname("not-a-url")).toBeNull();
    expect(extractSelfHostname("")).toBeNull();
    expect(extractSelfHostname(undefined)).toBeNull();
    expect(extractSelfHostname(null)).toBeNull();
  });
});

describe("isSelfRequest (P0 #7)", () => {
  it("returns true when the request hostname matches", () => {
    expect(isSelfRequest("https://api.cross-deck.com/v1/events", "api.cross-deck.com")).toBe(true);
  });

  it("returns true on a CUSTOM baseUrl-derived hostname (regional / staging / self-hosted)", () => {
    // Pre-fix the skip was hardcoded to "api.cross-deck.com" — any
    // customer pointing the SDK at a regional / staging / self-hosted
    // base URL recursed: SDK 5xx → captureHttp → enqueue → /events
    // → captureHttp → ∞. Post-fix the skip is derived from baseUrl
    // via extractSelfHostname.
    expect(
      isSelfRequest(
        "https://crossdeck-eu.customer.example/v1/events",
        "crossdeck-eu.customer.example",
      ),
    ).toBe(true);
  });

  it("is case-insensitive on the request hostname", () => {
    expect(isSelfRequest("https://API.Cross-Deck.COM/v1/events", "api.cross-deck.com")).toBe(true);
  });

  it("is hostname-STRICT — substring matches do NOT count (attacker.example with our host as a prefix)", () => {
    // Pre-fix `url.includes("api.cross-deck.com")` would have falsely
    // matched `https://api.cross-deck.com.attacker.example/...` and
    // SKIPPED capture for what's actually a malicious / unrelated host.
    // New impl parses URL + compares hostname strictly.
    expect(
      isSelfRequest("https://api.cross-deck.com.attacker.example/v1/events", "api.cross-deck.com"),
    ).toBe(false);
    expect(isSelfRequest("https://evil-api.cross-deck.com/x", "api.cross-deck.com")).toBe(false);
  });

  it("returns false on a non-matching hostname", () => {
    expect(isSelfRequest("https://example.com/v1/events", "api.cross-deck.com")).toBe(false);
    expect(isSelfRequest("https://api.stripe.com/v1/charges", "api.cross-deck.com")).toBe(false);
  });

  it("returns false when selfHostname is null / undefined (safe fall-through)", () => {
    // No self to skip — the wrap captures everything. Better than
    // swallowing a legitimate 5xx on a config typo.
    expect(isSelfRequest("https://api.cross-deck.com/v1/events", null)).toBe(false);
    expect(isSelfRequest("https://api.cross-deck.com/v1/events", undefined)).toBe(false);
  });

  it("returns false on a malformed request URL (SDK only ever uses absolute URLs)", () => {
    expect(isSelfRequest("not-a-url", "api.cross-deck.com")).toBe(false);
    expect(isSelfRequest("", "api.cross-deck.com")).toBe(false);
    expect(isSelfRequest("/relative/path", "api.cross-deck.com")).toBe(false);
  });
});
