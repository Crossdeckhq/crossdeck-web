import { describe, it, expect } from "vitest";
import { SuperPropertyStore } from "../src/super-properties";
import { MemoryStorage } from "../src/storage";

describe("SuperPropertyStore — register / unregister", () => {
  it("starts empty", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    expect(s.getSuperProperties()).toEqual({});
  });

  it("register merges keys", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.register({ plan: "pro" });
    s.register({ release: "beta" });
    expect(s.getSuperProperties()).toEqual({ plan: "pro", release: "beta" });
  });

  it("register with null value removes the key (Mixpanel semantics)", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.register({ plan: "pro", release: "beta" });
    s.register({ plan: null });
    expect(s.getSuperProperties()).toEqual({ release: "beta" });
  });

  it("register with undefined value is a no-op (not the same as null)", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.register({ plan: "pro" });
    s.register({ plan: undefined });
    expect(s.getSuperProperties()).toEqual({ plan: "pro" });
  });

  it("unregister removes a key", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.register({ plan: "pro", release: "beta" });
    s.unregister("plan");
    expect(s.getSuperProperties()).toEqual({ release: "beta" });
  });

  it("unregister an absent key is idempotent", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    expect(() => s.unregister("nope")).not.toThrow();
  });

  it("persists across instances via the storage", () => {
    const storage = new MemoryStorage();
    new SuperPropertyStore(storage, "cd:").register({ plan: "pro" });
    const reopened = new SuperPropertyStore(storage, "cd:");
    expect(reopened.getSuperProperties()).toEqual({ plan: "pro" });
  });

  it("getSuperProperties returns a defensive copy (caller mutation doesn't leak)", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.register({ plan: "pro" });
    const snapshot = s.getSuperProperties();
    snapshot.plan = "free";
    expect(s.getSuperProperties()).toEqual({ plan: "pro" });
  });
});

describe("SuperPropertyStore — groups", () => {
  it("setGroup attaches a type → id mapping", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.setGroup("org", "acme_inc");
    expect(s.getGroupIds()).toEqual({ org: "acme_inc" });
  });

  it("setGroup with traits stores them too", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.setGroup("team", "design", { headcount: 12 });
    const groups = s.getGroups();
    expect(groups.team).toEqual({ id: "design", traits: { headcount: 12 } });
  });

  it("setGroup with id=null clears the group", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.setGroup("org", "acme_inc");
    s.setGroup("org", null);
    expect(s.getGroupIds()).toEqual({});
  });

  it("supports multiple group types simultaneously", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.setGroup("org", "acme");
    s.setGroup("team", "design");
    s.setGroup("plan", "enterprise");
    expect(s.getGroupIds()).toEqual({ org: "acme", team: "design", plan: "enterprise" });
  });

  it("persists groups across instances", () => {
    const storage = new MemoryStorage();
    new SuperPropertyStore(storage, "cd:").setGroup("org", "acme");
    const reopened = new SuperPropertyStore(storage, "cd:");
    expect(reopened.getGroupIds()).toEqual({ org: "acme" });
  });
});

describe("SuperPropertyStore — clear", () => {
  it("clear() wipes both super-props and groups", () => {
    const s = new SuperPropertyStore(new MemoryStorage(), "cd:");
    s.register({ plan: "pro" });
    s.setGroup("org", "acme");
    s.clear();
    expect(s.getSuperProperties()).toEqual({});
    expect(s.getGroupIds()).toEqual({});
  });
});
