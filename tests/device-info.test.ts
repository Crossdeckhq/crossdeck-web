/**
 * device-info parser tests. Pure-function — runs under node environment;
 * the browser-side collectDeviceInfo() integration is exercised in
 * crossdeck.test.ts under jsdom.
 */

import { describe, it, expect } from "vitest";
import { parseUserAgent, isBrowser, collectDeviceInfo } from "../src/device-info";

describe("isBrowser — node environment", () => {
  it("returns false in Node", () => {
    expect(isBrowser()).toBe(false);
  });
});

describe("collectDeviceInfo — node environment", () => {
  it("returns empty object when no extras and no browser globals", () => {
    expect(collectDeviceInfo()).toEqual({});
  });

  it("returns appVersion alone when extra is provided in Node", () => {
    expect(collectDeviceInfo({ appVersion: "1.2.3" })).toEqual({ appVersion: "1.2.3" });
  });
});

describe("parseUserAgent — operating systems", () => {
  it.each([
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      { os: "iOS", osVersion: "17.4" },
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      { os: "iOS", osVersion: "16.6" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      { os: "Android", osVersion: "14" },
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      { os: "macOS", osVersion: "10.15.7" },
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      { os: "Windows", osVersion: "10.0" },
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      { os: "Linux" },
    ],
  ])("parses OS from %s", (ua, expected) => {
    const result = parseUserAgent(ua);
    expect(result.os).toBe(expected.os);
    if ("osVersion" in expected) expect(result.osVersion).toBe(expected.osVersion);
  });

  it("iOS detection takes precedence over macOS for iPad UAs that claim Macintosh", () => {
    const ua =
      "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/604.1";
    expect(parseUserAgent(ua).os).toBe("iOS");
  });

  it("Android detection takes precedence over Linux", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    expect(parseUserAgent(ua).os).toBe("Android");
  });
});

describe("parseUserAgent — browsers", () => {
  it("Edge wins over Chrome (Edge UA contains 'Chrome')", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.86";
    expect(parseUserAgent(ua).browser).toBe("Edge");
    expect(parseUserAgent(ua).browserVersion).toBe("131.0.2903.86");
  });

  it("Chrome wins over Safari (Chrome UA contains 'Safari')", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    expect(parseUserAgent(ua).browser).toBe("Chrome");
    expect(parseUserAgent(ua).browserVersion).toBe("131.0.0.0");
  });

  it("Safari is recognised when Version/X is present + 'Safari' suffix", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
    expect(parseUserAgent(ua).browser).toBe("Safari");
    expect(parseUserAgent(ua).browserVersion).toBe("17.5");
  });

  it("Firefox", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; rv:124.0) Gecko/20100101 Firefox/124.0";
    expect(parseUserAgent(ua).browser).toBe("Firefox");
    expect(parseUserAgent(ua).browserVersion).toBe("124.0");
  });

  it("Opera", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 OPR/118.0.5461.123";
    expect(parseUserAgent(ua).browser).toBe("Opera");
    expect(parseUserAgent(ua).browserVersion).toBe("118.0.5461.123");
  });

  it("unknown UA → no browser field (silent fall-through)", () => {
    const result = parseUserAgent("CustomBot/1.0");
    expect(result.browser).toBeUndefined();
  });

  it("empty UA → empty result", () => {
    expect(parseUserAgent("")).toEqual({});
  });
});

describe("parseUserAgent — combined OS + browser", () => {
  it("real iPhone Safari UA", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    const r = parseUserAgent(ua);
    expect(r).toEqual({
      os: "iOS",
      osVersion: "17.4",
      browser: "Safari",
      browserVersion: "17.4",
    });
  });

  it("real Android Chrome UA", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    const r = parseUserAgent(ua);
    expect(r).toEqual({
      os: "Android",
      osVersion: "14",
      browser: "Chrome",
      browserVersion: "131.0.0.0",
    });
  });
});
