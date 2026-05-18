import { describe, it, expect } from "vitest";
import { ConsentManager, scrubPii, scrubPiiFromProperties } from "../src/consent";

describe("ConsentManager — default state", () => {
  it("starts with everything granted", () => {
    const c = new ConsentManager();
    expect(c.get()).toEqual({ analytics: true, marketing: true, errors: true });
    expect(c.analytics).toBe(true);
    expect(c.marketing).toBe(true);
    expect(c.errors).toBe(true);
  });
});

describe("ConsentManager — set()", () => {
  it("merges partial state", () => {
    const c = new ConsentManager();
    c.set({ marketing: false });
    expect(c.get()).toEqual({ analytics: true, marketing: false, errors: true });
  });

  it("ignores non-boolean values", () => {
    const c = new ConsentManager();
    c.set({ analytics: "false" as unknown as boolean });
    expect(c.analytics).toBe(true);
  });

  it("can be flipped back on by another set()", () => {
    const c = new ConsentManager();
    c.set({ analytics: false });
    c.set({ analytics: true });
    expect(c.analytics).toBe(true);
  });
});

describe("ConsentManager — DNT", () => {
  it("does NOT apply DNT when respectDnt is off (default)", () => {
    const origNav = (globalThis as { navigator?: Navigator }).navigator;
    (globalThis as unknown as { navigator: unknown }).navigator = {
      doNotTrack: "1",
    } as unknown as Navigator;
    try {
      const c = new ConsentManager();
      expect(c.isDntDenied).toBe(false);
      expect(c.analytics).toBe(true);
    } finally {
      (globalThis as { navigator?: Navigator }).navigator = origNav;
    }
  });

  it("applies DNT when respectDnt: true and navigator.doNotTrack === '1'", () => {
    const origNav = (globalThis as { navigator?: Navigator }).navigator;
    (globalThis as unknown as { navigator: unknown }).navigator = {
      doNotTrack: "1",
    } as unknown as Navigator;
    try {
      const c = new ConsentManager({ respectDnt: true });
      expect(c.isDntDenied).toBe(true);
      expect(c.analytics).toBe(false);
      expect(c.marketing).toBe(false);
      expect(c.errors).toBe(false);
    } finally {
      (globalThis as { navigator?: Navigator }).navigator = origNav;
    }
  });

  it("DNT-derived denies cannot be flipped back on", () => {
    const origNav = (globalThis as { navigator?: Navigator }).navigator;
    (globalThis as unknown as { navigator: unknown }).navigator = {
      doNotTrack: "1",
    } as unknown as Navigator;
    try {
      const c = new ConsentManager({ respectDnt: true });
      c.set({ analytics: true });
      expect(c.analytics).toBe(false);
    } finally {
      (globalThis as { navigator?: Navigator }).navigator = origNav;
    }
  });
});

describe("scrubPii", () => {
  it("returns the same string when no PII is present", () => {
    expect(scrubPii("hello world")).toBe("hello world");
  });

  it("replaces email addresses with [email]", () => {
    expect(scrubPii("user wes@pinet.co.za signed up")).toBe("user [email] signed up");
  });

  it("replaces card numbers with [card]", () => {
    expect(scrubPii("paid with 4242 4242 4242 4242 today")).toBe("paid with [card] today");
  });

  it("replaces both in a single string", () => {
    const result = scrubPii("wes@pinet.co.za used 4242424242424242");
    expect(result).toContain("[email]");
    expect(result).toContain("[card]");
  });

  it("handles multiple emails in one string", () => {
    const result = scrubPii("a@b.com and c@d.com");
    expect(result).toBe("[email] and [email]");
  });

  it("is regex-safe (no carry-over state between calls)", () => {
    scrubPii("a@b.com");
    expect(scrubPii("c@d.com")).toBe("[email]");
  });
});

describe("scrubPiiFromProperties", () => {
  it("scrubs string values", () => {
    const out = scrubPiiFromProperties({ url: "/users/wes@pinet.co.za/edit", count: 3 });
    expect(out.url).toBe("/users/[email]/edit");
    expect(out.count).toBe(3);
  });

  it("scrubs strings inside arrays", () => {
    const out = scrubPiiFromProperties({ tags: ["x@y.com", "ok"] });
    expect(out.tags).toEqual(["[email]", "ok"]);
  });

  it("passes non-string values through unchanged", () => {
    const date = new Date();
    const out = scrubPiiFromProperties({ when: date, n: 5, b: true, z: null });
    expect(out.when).toBe(date);
    expect(out.n).toBe(5);
    expect(out.b).toBe(true);
    expect(out.z).toBeNull();
  });

  it("does not mutate the caller's input", () => {
    const input = { url: "/users/wes@pinet.co.za/edit" };
    scrubPiiFromProperties(input);
    expect(input.url).toBe("/users/wes@pinet.co.za/edit");
  });
});
