/**
 * Regression: entitlements must survive identify(), and the per-user-cache-
 * isolation self-check must not false-fail on a legitimate rehydrate.
 *
 * Two real SDK bugs found via the biotree dogfood console:
 *   A. anon getEntitlements() then identify() left isEntitled() === false — the
 *      anonymous session's entitlements were stranded in the _anon slot and never
 *      carried into the new user's slot. identify() now carries them (same person).
 *   B. rotating into a RETURNING user (whose slot has persisted last-known-good)
 *      rehydrates their own cache — list() is non-empty — which the onIdentify
 *      verifier wrongly reported as an isolation breach ("still held entitlements
 *      after slot rotation"). The invariant is now "snapshot sourced from the new
 *      slot", which holds for both a fresh and a returning user.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CrossdeckClient } from "../src/crossdeck";
import { MemoryStorage } from "../src/storage";
import { EntitlementCache } from "../src/entitlement-cache";

const ORIG = globalThis.fetch;
const PRO = { object: "entitlement", key: "pro", isActive: true, validUntil: null,
  source: { rail: "stripe", productId: "p", subscriptionId: "s" }, updatedAt: Date.now() } as any;
const res = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
function routed() {
  return vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes("/entitlements")) return res({ object: "list", data: [PRO], crossdeckCustomerId: "cdcust_847" });
    if (u.includes("/identity/alias")) return res({ crossdeckCustomerId: "cdcust_847" });
    return res({ ok: true });
  });
}
function mem(): any { return { m: new Map<string,string>(), getItem(k:string){return this.m.get(k)??null;}, setItem(k:string,v:string){this.m.set(k,v);}, removeItem(k:string){this.m.delete(k);} }; }

beforeEach(() => { globalThis.fetch = ORIG; });
afterEach(() => { globalThis.fetch = ORIG; });

describe("entitlements survive identify()", () => {
  it("BUG A — anon getEntitlements(pro) then identify() keeps isEntitled('pro') TRUE", async () => {
    globalThis.fetch = routed() as any;
    const c = new CrossdeckClient();
    c.init({ appId: "app_web_test", publicKey: "cd_pub_test_001", environment: "sandbox",
      storage: new MemoryStorage(), autoHeartbeat: false, disableContractAssertions: true });
    await c.getEntitlements();
    expect(c.isEntitled("pro")).toBe(true);
    await c.identify("user_847");
    expect(c.isEntitled("pro")).toBe(true);
  });

  it("DEFECT 2 — a stale getEntitlements resolving AFTER an identity rotation must not clobber the current identity", async () => {
    // The anonymous boot fetch (returns []) is held in flight, then resolves
    // LATE — after we've identified a paying user. Its generation is stale,
    // so its write must be dropped; last-writer-wins would otherwise flip a
    // pro customer back to free.
    let releaseAnon!: (v: unknown) => void;
    const anonPending = new Promise((r) => { releaseAnon = r; });
    let entCall = 0;
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/identity/alias")) return res({ crossdeckCustomerId: "cdcust_847" });
      if (u.includes("/entitlements")) {
        entCall += 1;
        if (entCall === 1) {
          await anonPending; // anon fetch hangs...
          return res({ object: "list", data: [], crossdeckCustomerId: null }); // ...then resolves free, stale
        }
        return res({ object: "list", data: [PRO], crossdeckCustomerId: "cdcust_847" }); // user_847 is pro
      }
      return res({ ok: true });
    }) as any;

    const c = new CrossdeckClient();
    c.init({ appId: "app_web_test", publicKey: "cd_pub_test_001", environment: "sandbox",
      storage: new MemoryStorage(), autoHeartbeat: false, disableContractAssertions: true });

    const anonFetch = c.getEntitlements().catch(() => {}); // in flight under the anon generation
    await c.identify("user_847"); // rotates identity (bumps generation) + refetches [pro]
    expect(c.isEntitled("pro")).toBe(true);

    releaseAnon(null); // stale anon [] resolves now, under the OLD generation
    await anonFetch;
    expect(c.isEntitled("pro")).toBe(true); // NOT clobbered
  });
});

describe("per-user cache isolation", () => {
  it("BUG B — returning user rehydrates own slot; snapshotMatchesCurrentSlot() is TRUE", () => {
    const s = mem();
    const c1 = new EntitlementCache(s, "iso"); c1.setUserKey("user_847"); c1.setFromList([PRO]);
    const c2 = new EntitlementCache(s, "iso"); c2.setUserKey("user_OTHER"); c2.setUserKey("user_847");
    expect(c2.list().length).toBe(1);
    expect(c2.isEntitled("pro")).toBe(true);
    expect(c2.snapshotMatchesCurrentSlot()).toBe(true);
  });

  it("SECURITY — user A -> fresh user B leaks nothing", () => {
    const s = mem();
    const cache = new EntitlementCache(s, "iso");
    cache.setUserKey("user_A"); cache.setFromList([PRO]);
    cache.setUserKey("user_B");
    expect(cache.isEntitled("pro")).toBe(false);
    expect(cache.list().length).toBe(0);
    expect(cache.snapshotMatchesCurrentSlot()).toBe(true);
  });
});
