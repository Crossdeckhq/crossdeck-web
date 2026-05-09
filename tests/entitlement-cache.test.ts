import { describe, it, expect } from "vitest";
import { EntitlementCache } from "../src/entitlement-cache";
import type { PublicEntitlement } from "../src/types";

function ent(key: string, isActive = true): PublicEntitlement {
  return {
    object: "entitlement",
    key,
    isActive,
    validUntil: null,
    source: { rail: "stripe", productId: "monthly_pro", subscriptionId: "sub_x" },
    updatedAt: 1_700_000_000,
  };
}

describe("EntitlementCache", () => {
  it("isEntitled returns false on a fresh cache", () => {
    const c = new EntitlementCache();
    expect(c.isEntitled("pro")).toBe(false);
  });

  it("setFromList populates the active set", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro"), ent("ai_insights")]);
    expect(c.isEntitled("pro")).toBe(true);
    expect(c.isEntitled("ai_insights")).toBe(true);
    expect(c.isEntitled("garbage")).toBe(false);
  });

  it("inactive entitlements are excluded from isEntitled", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro", true), ent("expired_thing", false)]);
    expect(c.isEntitled("pro")).toBe(true);
    expect(c.isEntitled("expired_thing")).toBe(false);
  });

  it("list() returns a snapshot, not a mutable reference", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro")]);
    const snap = c.list();
    snap.pop(); // mutate the snapshot
    expect(c.list().length).toBe(1); // cache untouched
  });

  it("setFromList replaces, doesn't merge", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro")]);
    c.setFromList([ent("ai_insights")]);
    expect(c.isEntitled("pro")).toBe(false);
    expect(c.isEntitled("ai_insights")).toBe(true);
  });

  it("clear() empties the cache", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro")]);
    c.clear();
    expect(c.isEntitled("pro")).toBe(false);
    expect(c.list()).toEqual([]);
  });

  it("freshness updates on every setFromList", () => {
    const c = new EntitlementCache();
    expect(c.freshness).toBe(0);
    c.setFromList([ent("pro")]);
    expect(c.freshness).toBeGreaterThan(0);
  });

  describe("subscribe (reactive listener API)", () => {
    it("fires listeners after setFromList with the new state", () => {
      const c = new EntitlementCache();
      const calls: string[][] = [];
      c.subscribe((entitlements) => calls.push(entitlements.map((e) => e.key)));

      c.setFromList([ent("pro")]);
      c.setFromList([ent("pro"), ent("ai_insights")]);

      expect(calls).toEqual([["pro"], ["pro", "ai_insights"]]);
    });

    it("fires listeners on clear()", () => {
      const c = new EntitlementCache();
      c.setFromList([ent("pro")]);
      const calls: string[][] = [];
      c.subscribe((entitlements) => calls.push(entitlements.map((e) => e.key)));

      c.clear();
      expect(calls).toEqual([[]]);
    });

    it("does NOT fire on subscribe (only on future mutations)", () => {
      const c = new EntitlementCache();
      c.setFromList([ent("pro")]);
      const calls: string[][] = [];
      c.subscribe((entitlements) => calls.push(entitlements.map((e) => e.key)));
      // No fire yet — caller must read state synchronously if they need it.
      expect(calls).toEqual([]);
    });

    it("returns an unsubscribe function that prevents future calls", () => {
      const c = new EntitlementCache();
      const calls: string[][] = [];
      const unsub = c.subscribe((entitlements) =>
        calls.push(entitlements.map((e) => e.key)),
      );
      c.setFromList([ent("pro")]);
      unsub();
      c.setFromList([ent("ai_insights")]);
      expect(calls).toEqual([["pro"]]);
    });

    it("unsubscribe is idempotent — calling twice is safe", () => {
      const c = new EntitlementCache();
      const unsub = c.subscribe(() => {});
      unsub();
      expect(() => unsub()).not.toThrow();
    });

    it("a listener throwing an error doesn't crash other listeners", () => {
      const c = new EntitlementCache();
      const calls: string[] = [];
      c.subscribe(() => {
        throw new Error("buggy consumer");
      });
      c.subscribe(() => calls.push("second listener fired"));

      expect(() => c.setFromList([ent("pro")])).not.toThrow();
      expect(calls).toEqual(["second listener fired"]);
    });

    it("a listener that unsubscribes itself during dispatch is safe", () => {
      const c = new EntitlementCache();
      const calls: string[] = [];
      let unsub: (() => void) | null = null;
      unsub = c.subscribe(() => {
        calls.push("self-unsub listener fired");
        unsub?.();
      });
      c.subscribe(() => calls.push("second listener fired"));

      c.setFromList([ent("pro")]);
      c.setFromList([ent("ai_insights")]);

      expect(calls).toEqual([
        "self-unsub listener fired",
        "second listener fired",
        // First listener already unsubscribed — only second fires now.
        "second listener fired",
      ]);
    });
  });
});
