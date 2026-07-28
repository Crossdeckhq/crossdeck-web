import { describe, it, expect } from "vitest";
import { EntitlementCache } from "../src/entitlement-cache";
import { MemoryStorage } from "../src/storage";
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

    it("counts listener errors via the listenerErrors getter", () => {
      const c = new EntitlementCache();
      expect(c.listenerErrors).toBe(0);
      c.subscribe(() => {
        throw new Error("buggy consumer");
      });
      c.subscribe(() => {
        throw new Error("also buggy");
      });
      c.setFromList([ent("pro")]);
      c.setFromList([ent("pro"), ent("ai")]);
      // 2 listeners x 2 fires = 4 throws, all counted.
      expect(c.listenerErrors).toBe(4);
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

  // ---------------------------------------------------------------------
  // Regression: the emitted STREAM on setUserKey(). These assert what
  // subscribers OBSERVE (onEntitlementsChange), not the final in-memory
  // state — the only lens that catches a notify-ordering fault. The
  // pre-fix same-id branch did notify() BEFORE hydrate(), flashing an
  // empty snapshot to every useEntitlement/useEntitlements/Vue subscriber,
  // which latched the paywall. Prior tests all passed because `this.all`
  // ends up correct after hydrate; only a stream assertion sees the bug.
  // ---------------------------------------------------------------------
  describe("setUserKey emitted stream (paywall-flash regression)", () => {
    it("same-user re-identify never emits an empty snapshot to subscribers", () => {
      const c = new EntitlementCache(new MemoryStorage());
      c.setUserKey("user_1");
      c.setFromList([ent("pro")]); // persist [pro] under user_1's slot
      const seen: string[][] = [];
      c.subscribe((snap) => seen.push(snap.map((e) => e.key)));
      // Progressive-trait re-identify: providers call identify() again with
      // the SAME uid as email/name populate. This is the hot path.
      c.setUserKey("user_1");
      expect(seen.length).toBeGreaterThan(0);
      // EVERY emission must carry pro — no transient [] the hook can latch.
      expect(seen.every((keys) => keys.includes("pro"))).toBe(true);
      expect(c.isEntitled("pro")).toBe(true);
    });

    it("returning to a prior user emits that user's settled entitlements, never empty", () => {
      const store = new MemoryStorage();
      const c = new EntitlementCache(store);
      c.setUserKey("user_A");
      c.setFromList([ent("pro")]); // A is pro
      c.setUserKey("user_B");
      c.setFromList([]); // B is free
      const seen: string[][] = [];
      c.subscribe((snap) => seen.push(snap.map((e) => e.key)));
      c.setUserKey("user_A"); // switch back — must restore + emit [pro]
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((keys) => keys.includes("pro"))).toBe(true);
      expect(c.isEntitled("pro")).toBe(true);
    });

    it("bumps generation on every setUserKey — switch AND same-id re-identify", () => {
      const c = new EntitlementCache(new MemoryStorage());
      const g0 = c.generation;
      c.setUserKey("user_1");
      expect(c.generation).toBeGreaterThan(g0);
      const g1 = c.generation;
      c.setUserKey("user_1"); // same id still counts (invalidates in-flight fetches)
      expect(c.generation).toBeGreaterThan(g1);
      const g2 = c.generation;
      c.setUserKey("user_2");
      expect(c.generation).toBeGreaterThan(g2);
    });
  });
});
