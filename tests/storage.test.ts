/**
 * Storage adapter tests — MemoryStorage, detectDefaultStorage, CookieStorage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CookieStorage, MemoryStorage, detectDefaultStorage, resolveCookieDomain } from "../src/storage";

describe("MemoryStorage", () => {
  it("set/get/remove round-trip", () => {
    const s = new MemoryStorage();
    expect(s.getItem("k")).toBeNull();
    s.setItem("k", "v");
    expect(s.getItem("k")).toBe("v");
    s.removeItem("k");
    expect(s.getItem("k")).toBeNull();
  });

  it("isolated per instance", () => {
    const a = new MemoryStorage();
    const b = new MemoryStorage();
    a.setItem("k", "v");
    expect(b.getItem("k")).toBeNull();
  });

  it("removing a missing key is a no-op (not an error)", () => {
    const s = new MemoryStorage();
    expect(() => s.removeItem("ghost")).not.toThrow();
  });
});

describe("detectDefaultStorage", () => {
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

  afterEach(() => {
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
    }
  });

  it("falls back to MemoryStorage when localStorage is undefined (Node)", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    const storage = detectDefaultStorage();
    expect(storage).toBeInstanceOf(MemoryStorage);
  });

  it("uses localStorage when available", () => {
    const fake = {
      _data: new Map<string, string>(),
      getItem(k: string) {
        return this._data.get(k) ?? null;
      },
      setItem(k: string, v: string) {
        this._data.set(k, v);
      },
      removeItem(k: string) {
        this._data.delete(k);
      },
    };
    (globalThis as { localStorage?: unknown }).localStorage = fake;
    const storage = detectDefaultStorage();
    expect(storage).toBe(fake);
  });

  it("falls back to MemoryStorage when localStorage probe throws (Safari private mode)", () => {
    const throwing = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {},
    };
    (globalThis as { localStorage?: unknown }).localStorage = throwing;
    const storage = detectDefaultStorage();
    expect(storage).toBeInstanceOf(MemoryStorage);
  });
});

describe("CookieStorage", () => {
  // We mock document.cookie via a single shared `cookieJar` string and
  // track every set so we can verify attributes. Real DOM behaviour
  // (browser parses `Path=/` etc. and stores per-domain) isn't simulated
  // beyond the substring checks below — that level of fidelity isn't
  // worth the test scaffolding complexity for adapter unit tests.
  const originalDocument = (globalThis as { document?: unknown }).document;
  let cookieJar: string;
  let lastSetRaw: string | null;

  beforeEach(() => {
    cookieJar = "";
    lastSetRaw = null;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: {
        get cookie() {
          return cookieJar;
        },
        set cookie(raw: string) {
          lastSetRaw = raw;
          // Tiny "store the foo=bar piece, drop everything after the
          // first `;` like a real browser would persist." Negative
          // Max-Age clears.
          const head = raw.split(";")[0]!;
          const [name, ...rest] = head.split("=");
          const value = rest.join("=");
          if (raw.includes("Max-Age=0") || raw.includes("Max-Age=-")) {
            cookieJar = cookieJar
              .split(/;\s*/)
              .filter((c) => !c.startsWith(name + "="))
              .join("; ");
          } else {
            const without = cookieJar
              .split(/;\s*/)
              .filter((c) => c && !c.startsWith(name + "="))
              .join("; ");
            cookieJar = without ? without + "; " + name + "=" + value : name + "=" + value;
          }
        },
      },
    });
  });

  afterEach(() => {
    if (originalDocument === undefined) {
      // jsdom default — restore by deleting our override
      delete (globalThis as { document?: unknown }).document;
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: originalDocument,
      });
    }
  });

  it("set/get/remove round-trip", () => {
    const s = new CookieStorage();
    expect(s.getItem("crossdeck:anon_id")).toBeNull();
    s.setItem("crossdeck:anon_id", "anon_abc");
    expect(s.getItem("crossdeck:anon_id")).toBe("anon_abc");
    s.removeItem("crossdeck:anon_id");
    expect(s.getItem("crossdeck:anon_id")).toBeNull();
  });

  it("URL-encodes keys and values to survive the cookie syntax", () => {
    const s = new CookieStorage();
    s.setItem("crossdeck:has space", "value;with;semicolons=and=equals");
    expect(s.getItem("crossdeck:has space")).toBe("value;with;semicolons=and=equals");
  });

  it("scopes the cookie to Domain= for cross-subdomain identity (set AND remove)", () => {
    const s = new CookieStorage({ domain: ".cross-deck.com" });
    s.setItem("crossdeck:anon_id", "anon_abc");
    expect(lastSetRaw).toContain("Domain=.cross-deck.com");
    s.removeItem("crossdeck:anon_id"); // removal must target the SAME domained cookie
    expect(lastSetRaw).toContain("Domain=.cross-deck.com");
  });

  it("host-only (no Domain=) by default — unchanged behaviour when no domain set", () => {
    const s = new CookieStorage();
    s.setItem("k", "v");
    expect(lastSetRaw).not.toContain("Domain=");
  });

  it("emits Path=/ + SameSite=Lax + Max-Age + Secure when over HTTPS", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "https:" },
    });
    const s = new CookieStorage();
    s.setItem("k", "v");
    expect(lastSetRaw).toContain("Path=/");
    expect(lastSetRaw).toContain("SameSite=Lax");
    expect(lastSetRaw).toContain("Max-Age=63072000");
    expect(lastSetRaw).toContain("Secure");
  });

  it("omits Secure when on http: (so localhost dev still works)", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "http:" },
    });
    const s = new CookieStorage();
    s.setItem("k", "v");
    expect(lastSetRaw).not.toContain("Secure");
  });

  it("returns null on broken cookie strings without throwing", () => {
    const s = new CookieStorage();
    cookieJar = "garbage=%%%; nothing=";
    expect(s.getItem("garbage")).toBeNull();
  });

  it("getItem returns null when document is absent (Node)", () => {
    delete (globalThis as { document?: unknown }).document;
    const s = new CookieStorage();
    expect(s.getItem("k")).toBeNull();
    // setItem must also no-op silently — never throw in Node
    expect(() => s.setItem("k", "v")).not.toThrow();
    expect(() => s.removeItem("k")).not.toThrow();
  });
});

describe("resolveCookieDomain — cross-subdomain identity", () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalLocation = (globalThis as { location?: unknown }).location;

  function mockBrowser(hostname: string) {
    let jar = "";
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        get cookie() { return jar; },
        set cookie(raw: string) {
          const head = raw.split(";")[0]!;
          const name = head.split("=")[0]!;
          if (raw.includes("Max-Age=0")) {
            jar = jar.split(/;\s*/).filter((c) => c && !c.startsWith(name + "=")).join("; ");
          } else {
            jar = jar ? jar + "; " + head : head;
          }
        },
      },
    });
    Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname } });
  }

  afterEach(() => {
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    if (originalLocation === undefined) delete (globalThis as { location?: unknown }).location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
  });

  it("an explicit domain string is normalised to a leading-dot domain", () => {
    expect(resolveCookieDomain("cross-deck.com")).toBe(".cross-deck.com");
    expect(resolveCookieDomain(".cross-deck.com")).toBe(".cross-deck.com");
  });

  it('"none" / undefined / empty → host-only (no domain cookie)', () => {
    expect(resolveCookieDomain("none")).toBeUndefined();
    expect(resolveCookieDomain(undefined)).toBeUndefined();
    expect(resolveCookieDomain("")).toBeUndefined();
  });

  it('"auto" on app.cross-deck.com → the registrable domain .cross-deck.com (marketing↔app share identity)', () => {
    mockBrowser("app.cross-deck.com");
    expect(resolveCookieDomain("auto")).toBe(".cross-deck.com");
  });

  it('"auto" on localhost / a bare IP → host-only (no domain cookie possible)', () => {
    mockBrowser("localhost");
    expect(resolveCookieDomain("auto")).toBeUndefined();
    mockBrowser("127.0.0.1");
    expect(resolveCookieDomain("auto")).toBeUndefined();
  });
});
