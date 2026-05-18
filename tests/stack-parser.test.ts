import { describe, it, expect } from "vitest";
import { parseStack, fingerprintError } from "../src/stack-parser";

describe("parseStack — Chrome format", () => {
  it("parses 'at Object.fn (file:line:col)'", () => {
    const stack = `Error: boom
    at Object.handleClick (https://app.com/app.js:42:18)
    at Array.forEach (<anonymous>)
    at https://app.com/anon.js:7:1`;
    const frames = parseStack(stack);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0]).toMatchObject({
      function: "Object.handleClick",
      filename: "https://app.com/app.js",
      lineno: 42,
      colno: 18,
      in_app: true,
    });
    expect(frames[frames.length - 1]).toMatchObject({
      function: "?",
      filename: "https://app.com/anon.js",
      lineno: 7,
      colno: 1,
    });
  });
});

describe("parseStack — Firefox / Safari format", () => {
  it("parses 'fn@file:line:col'", () => {
    const stack = `handleClick@https://app.com/app.js:42:18
forEach@<anonymous>:1:1
@https://app.com/main.js:5:9`;
    const frames = parseStack(stack);
    expect(frames[0]).toMatchObject({
      function: "handleClick",
      filename: "https://app.com/app.js",
      lineno: 42,
      colno: 18,
    });
    // The last frame's function is empty in Firefox stack — should
    // become "?".
    expect(frames[frames.length - 1]!.function).toBe("?");
  });
});

describe("parseStack — degenerate input", () => {
  it("returns [] for null / undefined / empty", () => {
    expect(parseStack(null)).toEqual([]);
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack("")).toEqual([]);
  });

  it("ignores the 'TypeError: foo' header line", () => {
    const stack = `TypeError: x is not a function
    at Object.fn (https://app.com/app.js:1:1)`;
    const frames = parseStack(stack);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.filename).toBe("https://app.com/app.js");
  });
});

describe("in_app detection", () => {
  it("marks browser-extension frames as out-of-app", () => {
    const frames = parseStack(`at fn (chrome-extension://abc/inject.js:1:1)`);
    expect(frames[0]!.in_app).toBe(false);
  });

  it("marks CDN frames as out-of-app", () => {
    const frames = parseStack(`at fn (https://cdn.jsdelivr.net/npm/lodash/index.js:1:1)`);
    expect(frames[0]!.in_app).toBe(false);
  });

  it("marks SDK's own bundle as out-of-app", () => {
    const frames = parseStack(`at fn (https://app.com/crossdeck.umd.min.js:1:1)`);
    expect(frames[0]!.in_app).toBe(false);
  });

  it("marks app code as in-app", () => {
    const frames = parseStack(`at fn (https://myapp.com/dist/app.js:42:18)`);
    expect(frames[0]!.in_app).toBe(true);
  });
});

describe("fingerprintError", () => {
  it("returns a stable 8-char hex string", () => {
    const fp = fingerprintError("x is not a function", [
      { function: "fn", filename: "/a.js", lineno: 1, colno: 1, in_app: true, raw: "" },
    ]);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it("same message + frames → same fingerprint", () => {
    const frames = [
      { function: "fn", filename: "/a.js", lineno: 1, colno: 1, in_app: true, raw: "" },
    ];
    expect(fingerprintError("boom", frames)).toBe(fingerprintError("boom", frames));
  });

  it("different message → different fingerprint", () => {
    const frames = [
      { function: "fn", filename: "/a.js", lineno: 1, colno: 1, in_app: true, raw: "" },
    ];
    expect(fingerprintError("boom", frames)).not.toBe(fingerprintError("kaboom", frames));
  });

  it("ignores out-of-app frames", () => {
    const inAppOnly = fingerprintError("boom", [
      { function: "fn", filename: "/a.js", lineno: 1, colno: 1, in_app: true, raw: "" },
    ]);
    const withVendor = fingerprintError("boom", [
      { function: "vendorFn", filename: "/vendor.js", lineno: 1, colno: 1, in_app: false, raw: "" },
      { function: "fn", filename: "/a.js", lineno: 1, colno: 1, in_app: true, raw: "" },
    ]);
    expect(inAppOnly).toBe(withVendor);
  });

  it("handles empty frames + empty message gracefully", () => {
    expect(fingerprintError("", [])).toMatch(/^[0-9a-f]{8}$/);
  });

  it("location fallback splits otherwise-identical empty-frame errors", () => {
    // Two "Unknown error"s from different files/lines must NOT
    // collapse into one fingerprint — the regression that motivated
    // the location-fallback parameter.
    const a = fingerprintError("Unknown error", [], {
      filename: "https://app.example/a.js",
      lineno: 10,
      colno: 5,
    });
    const b = fingerprintError("Unknown error", [], {
      filename: "https://app.example/b.js",
      lineno: 99,
      colno: 1,
    });
    expect(a).not.toBe(b);
  });

  it("location fallback is ignored when in-app frames are present", () => {
    const frames = [
      { function: "fn", filename: "/a.js", lineno: 1, colno: 1, in_app: true, raw: "" },
    ];
    const withLoc = fingerprintError("boom", frames, {
      filename: "/anywhere.js",
      lineno: 999,
    });
    const withoutLoc = fingerprintError("boom", frames);
    expect(withLoc).toBe(withoutLoc);
  });
});
