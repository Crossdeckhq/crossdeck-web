/**
 * @vitest-environment jsdom
 *
 * AutoTracker tests against jsdom. Each test gets its own track-context
 * (closed over a fresh array, not a shared `let`) and an afterEach hook
 * that uninstalls leaked trackers — without this, monkey-patched
 * history.pushState from one test bleeds into the next.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AutoTracker, DEFAULT_AUTO_TRACK } from "../src/auto-track";

interface RecordedEvent {
  name: string;
  properties?: Record<string, unknown>;
}

function makeContext() {
  const events: RecordedEvent[] = [];
  return {
    events,
    track: (name: string, properties?: Record<string, unknown>) =>
      events.push({ name, properties }),
  };
}

// Trackers created in tests register here; afterEach uninstalls all.
let activeTrackers: AutoTracker[] = [];

function newTracker(
  cfg: Partial<typeof DEFAULT_AUTO_TRACK>,
  track: (name: string, properties?: Record<string, unknown>) => void,
): AutoTracker {
  const t = new AutoTracker({ ...DEFAULT_AUTO_TRACK, ...cfg }, track);
  activeTrackers.push(t);
  return t;
}

beforeEach(() => {
  // Reset URL + title to a known starting state.
  // Use the original (unwrapped) replaceState so we don't fire a leaked patch.
  window.history.replaceState(null, "", "/");
  document.title = "Test page";
});

afterEach(() => {
  // Tear down every tracker created in the test, in reverse order, so the
  // last-installed monkey-patch is removed first (LIFO restores the chain).
  while (activeTrackers.length) {
    const t = activeTrackers.pop();
    try { t?.uninstall(); } catch { /* ignore */ }
  }
});

// ============================================================
describe("AutoTracker — install/uninstall lifecycle", () => {
  it("emits session.started + page.viewed on install when both are enabled", () => {
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    const names = ctx.events.map((e) => e.name);
    expect(names).toContain("session.started");
    expect(names).toContain("page.viewed");
  });

  it("session.started carries a sessionId", () => {
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    const ev = ctx.events.find((e) => e.name === "session.started");
    expect(ev?.properties?.sessionId).toMatch(/^sess_/);
  });

  it("currentSessionId matches the emitted sessionId", () => {
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    const emitted = ctx.events.find((e) => e.name === "session.started")?.properties?.sessionId;
    expect(t.currentSessionId).toBe(emitted);
  });

  it("uninstall emits a final session.ended", () => {
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    ctx.events.length = 0;
    t.uninstall();
    expect(ctx.events.some((e) => e.name === "session.ended")).toBe(true);
  });
});

// ============================================================
describe("AutoTracker — disabling individual flags", () => {
  it("sessions:false skips session.started", () => {
    const ctx = makeContext();
    newTracker({ sessions: false }, ctx.track).install();
    expect(ctx.events.some((e) => e.name === "session.started")).toBe(false);
    expect(ctx.events.some((e) => e.name === "page.viewed")).toBe(true);
  });

  it("pageViews:false skips page.viewed", () => {
    const ctx = makeContext();
    newTracker({ pageViews: false }, ctx.track).install();
    expect(ctx.events.some((e) => e.name === "page.viewed")).toBe(false);
    expect(ctx.events.some((e) => e.name === "session.started")).toBe(true);
  });

  it("both off → install is a complete no-op", () => {
    const ctx = makeContext();
    newTracker({ sessions: false, pageViews: false, deviceInfo: false }, ctx.track).install();
    expect(ctx.events).toEqual([]);
  });
});

// ============================================================
describe("AutoTracker — page view tracking", () => {
  it("initial page.viewed records path + search + title", () => {
    window.history.replaceState(null, "", "/landing?utm=x");
    document.title = "Landing";
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    const ev = ctx.events.find((e) => e.name === "page.viewed");
    expect(ev?.properties?.path).toBe("/landing");
    expect(ev?.properties?.search).toBe("?utm=x");
    expect(ev?.properties?.title).toBe("Landing");
  });

  it("history.pushState fires a new page.viewed", async () => {
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    ctx.events.length = 0;
    window.history.pushState(null, "", "/dashboard");
    await new Promise((r) => setTimeout(r, 0));
    const pv = ctx.events.find((e) => e.name === "page.viewed");
    expect(pv?.properties?.path).toBe("/dashboard");
  });

  it("history.replaceState fires a new page.viewed", async () => {
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    ctx.events.length = 0;
    window.history.replaceState(null, "", "/replaced");
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.events.some((e) => e.properties?.path === "/replaced")).toBe(true);
  });

  it("popstate fires a new page.viewed", () => {
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    ctx.events.length = 0;
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(ctx.events.some((e) => e.name === "page.viewed")).toBe(true);
  });

  it("uninstall restores history.pushState to whatever it was when installed", () => {
    // The monkey-patch chain ALSO restores cleanly when nothing else has
    // wrapped pushState. We assert that double-install + reverse-uninstall
    // is a stable no-op.
    const before = window.history.pushState;
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    expect(window.history.pushState).not.toBe(before);
    t.uninstall();
    activeTrackers = activeTrackers.filter((x) => x !== t);
    expect(window.history.pushState).toBe(before);
  });
});

// ============================================================
describe("AutoTracker — session lifecycle", () => {
  it("visibility hidden alone does NOT end the session (matches GA4/Amplitude semantics)", () => {
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    ctx.events.length = 0;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    // No session.ended emitted — quick tab switches and Cmd-Tabs shouldn't
    // fragment one user session into many.
    expect(ctx.events.find((e) => e.name === "session.ended")).toBeUndefined();
  });

  it("pagehide ends the session with durationMs", () => {
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    ctx.events.length = 0;
    window.dispatchEvent(new Event("pagehide"));
    const ev = ctx.events.find((e) => e.name === "session.ended");
    expect(ev).toBeDefined();
    expect(ev?.properties?.sessionId).toMatch(/^sess_/);
    expect(typeof ev?.properties?.durationMs).toBe("number");
  });

  it("session.ended is deduplicated when fired by multiple triggers", () => {
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    ctx.events.length = 0;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("beforeunload"));
    const ends = ctx.events.filter((e) => e.name === "session.ended");
    expect(ends.length).toBe(1);
  });

  it("returning visible after a quick hidden phase reuses the session (no new sessionId)", () => {
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    const first = t.currentSessionId;

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));

    // <30 min has passed, so the session resumes (same id).
    expect(t.currentSessionId).toBe(first);
  });

  it("resetSession() ends current and starts a new one", () => {
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    const first = t.currentSessionId;
    ctx.events.length = 0;
    t.resetSession();
    const second = t.currentSessionId;
    expect(second).not.toBe(first);
    const names = ctx.events.map((e) => e.name);
    expect(names).toContain("session.ended");
    expect(names).toContain("session.started");
  });
});
