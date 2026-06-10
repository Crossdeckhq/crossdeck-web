/**
 * @vitest-environment jsdom
 *
 * AutoTracker tests against jsdom. Each test gets its own track-context
 * (closed over a fresh array, not a shared `let`) and an afterEach hook
 * that uninstalls leaked trackers — without this, monkey-patched
 * history.pushState from one test bleeds into the next.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AutoTracker, DEFAULT_AUTO_TRACK, captureAcquisition } from "../src/auto-track";
import { MemoryStorage } from "../src/storage";

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
  storage?: MemoryStorage,
): AutoTracker {
  const t = new AutoTracker(
    { ...DEFAULT_AUTO_TRACK, ...cfg },
    track,
    storage ? { storage } : undefined,
  );
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

  it("pagehide does NOT end the session — a navigation is not a session end", () => {
    // Pre-fix, pagehide/beforeunload emitted session.ended, so every
    // full-page navigation on a multi-page site ended one session and
    // the next page started another at the same instant. A page unload
    // is a navigation, not an end: the session now ends only on real
    // 30-min inactivity or an explicit uninstall().
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    ctx.events.length = 0;
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("beforeunload"));
    expect(ctx.events.find((e) => e.name === "session.ended")).toBeUndefined();
  });

  it("session.ended fires exactly once on uninstall, after pagehide/visibility churn", () => {
    // pagehide/beforeunload/hidden no longer end the session; the single
    // real end (explicit uninstall) must still emit exactly one
    // session.ended, guarded by endedSent.
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    ctx.events.length = 0;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("beforeunload"));
    t.uninstall();
    const ends = ctx.events.filter((e) => e.name === "session.ended");
    expect(ends.length).toBe(1);
    expect(ends[0]?.properties?.sessionId).toMatch(/^sess_/);
    expect(typeof ends[0]?.properties?.durationMs).toBe("number");
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

  it("resetSession() nulls pageviewId so post-reset events don't ship prior attribution (P1 #16 regression)", () => {
    // Pre-fix pageviewId survived 30-min idle resets and silently
    // corrupted post-resume event → pageview correlation. New
    // contract: pageviewId nulls on session boundary, repopulates on
    // the next page.viewed.
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    expect(t.currentPageviewId).toMatch(/^pv_/); // initial page.viewed fired
    t.resetSession();
    expect(t.currentPageviewId).toBeNull();
  });
});

// ============================================================
// Session continuity across full-page navigations. A multi-page site
// re-installs the SDK on every page; with a persistent store the visit
// must RESUME as one session, not split into one-session-per-page (each
// ended at the instant the next began — the journey double-log bug).
// ============================================================
describe("AutoTracker — session continuity across page loads", () => {
  const SESSION_KEY = "crossdeck:session";

  it("resumes the stored session on the next install — no second session.started, same id", () => {
    const storage = new MemoryStorage();
    // Page 1.
    const ctx1 = makeContext();
    const t1 = newTracker({}, ctx1.track, storage);
    t1.install();
    const id1 = t1.currentSessionId;
    expect(ctx1.events.filter((e) => e.name === "session.started").length).toBe(1);

    // Navigate away — persists, does not end.
    window.dispatchEvent(new Event("pagehide"));

    // Page 2: a fresh tracker on the SAME storage = same browser, next page.
    const ctx2 = makeContext();
    const t2 = newTracker({}, ctx2.track, storage);
    t2.install();

    expect(t2.currentSessionId).toBe(id1);
    expect(ctx2.events.some((e) => e.name === "session.started")).toBe(false);
  });

  it("starts a new session when the stored one is past the 30-min window", () => {
    const storage = new MemoryStorage();
    const stale = Date.now() - 31 * 60 * 1000;
    storage.setItem(SESSION_KEY, JSON.stringify({
      id: "sess_stale", startedAt: stale - 1000, lastActivityAt: stale, acquisition: {},
    }));
    const ctx = makeContext();
    const t = newTracker({}, ctx.track, storage);
    t.install();
    expect(t.currentSessionId).not.toBe("sess_stale");
    expect(ctx.events.some((e) => e.name === "session.started")).toBe(true);
  });

  it("a resumed session keeps its first-touch acquisition, ignoring the new page's URL", () => {
    const storage = new MemoryStorage();
    window.history.replaceState(null, "", "/?utm_source=first");
    const t1 = newTracker({}, makeContext().track, storage);
    t1.install();
    expect(t1.currentAcquisition.utm_source).toBe("first");

    window.dispatchEvent(new Event("pagehide"));
    // Next page lands on a different campaign URL — must NOT overwrite the
    // session's first-touch attribution.
    window.history.replaceState(null, "", "/page2?utm_source=second");
    const t2 = newTracker({}, makeContext().track, storage);
    t2.install();
    expect(t2.currentAcquisition.utm_source).toBe("first");
  });

  it("explicit uninstall clears the stored session so the next start is fresh", () => {
    const storage = new MemoryStorage();
    const t1 = newTracker({}, makeContext().track, storage);
    t1.install();
    const id1 = t1.currentSessionId;
    t1.uninstall();

    const ctx2 = makeContext();
    const t2 = newTracker({}, ctx2.track, storage);
    t2.install();
    expect(t2.currentSessionId).not.toBe(id1);
    expect(ctx2.events.some((e) => e.name === "session.started")).toBe(true);
  });
});

// ============================================================
// v0.6.0 — first-touch acquisition capture (utm_* + referrer)
// Captured once at session start; attached to every event of the
// session by Crossdeck.track via tracker.currentAcquisition.
// ============================================================
describe("AutoTracker — acquisition capture (v0.6.0)", () => {
  it("captureAcquisition reads utm_* params off the URL", () => {
    window.history.replaceState(null, "", "/landing?utm_source=newsletter&utm_medium=email&utm_campaign=launch");
    const a = captureAcquisition();
    expect(a.utm_source).toBe("newsletter");
    expect(a.utm_medium).toBe("email");
    expect(a.utm_campaign).toBe("launch");
    expect(a.utm_content).toBe("");
    expect(a.utm_term).toBe("");
  });

  it("captureAcquisition returns empty strings for a clean URL with no params", () => {
    window.history.replaceState(null, "", "/");
    const a = captureAcquisition();
    expect(a.utm_source).toBe("");
    expect(a.utm_medium).toBe("");
    expect(a.utm_campaign).toBe("");
  });

  it("currentAcquisition reflects the URL captured AT SESSION START, not on each call", () => {
    // GA4 contract: utm_* are session-pinned. The user might land on
    // /?utm_source=newsletter, the SPA might rewrite to /home, but the
    // session attribution stays "newsletter" for the entire visit.
    window.history.replaceState(null, "", "/?utm_source=newsletter");
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();

    // Immediately after install, acquisition reflects landing URL
    expect(t.currentAcquisition.utm_source).toBe("newsletter");

    // SPA navigation strips the params away — but the session's
    // captured-at-start attribution must NOT change.
    window.history.replaceState(null, "", "/home");
    expect(t.currentAcquisition.utm_source).toBe("newsletter");
  });

  it("resetSession() re-captures acquisition off the current URL (new session = new attribution)", () => {
    window.history.replaceState(null, "", "/?utm_source=first");
    const ctx = makeContext();
    const t = newTracker({}, ctx.track);
    t.install();
    expect(t.currentAcquisition.utm_source).toBe("first");

    window.history.replaceState(null, "", "/?utm_source=second");
    t.resetSession();
    expect(t.currentAcquisition.utm_source).toBe("second");
  });

  it("currentAcquisition returns empty values when there is no active session", () => {
    const t = newTracker({ sessions: false }, makeContext().track);
    // No install → no session → empty acquisition (not undefined)
    expect(t.currentAcquisition.utm_source).toBe("");
    expect(t.currentAcquisition.referrer).toBe("");
  });
});

// ============================================================
// Click autocapture — label resolution. The bug these guard: a clicked
// control that WRAPS other controls or a content block used to collapse
// its whole subtree into one mashed label ("Log inContinue with Google
// Continue with Apple…", "Tudo que você é,em um só link.Portfolio…").
// ============================================================
describe("AutoTracker — click label resolution", () => {
  // Fire a real click on `el` and return the element.clicked props.
  function clickAndRead(el: Element, ctx: ReturnType<typeof makeContext>) {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    return ctx.events.find((e) => e.name === "element.clicked")?.properties;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("a simple button resolves to its own text", () => {
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    document.body.innerHTML = `<button id="b">Sign up</button>`;
    const props = clickAndRead(document.getElementById("b")!, ctx);
    expect(props?.text).toBe("Sign up");
  });

  it("icon-and-label button drops the svg and keeps the caption", () => {
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    document.body.innerHTML =
      `<button id="b"><svg><title>save icon</title></svg><span>Save</span></button>`;
    const props = clickAndRead(document.getElementById("b")!, ctx);
    expect(props?.text).toBe("Save");
  });

  it("inline label parts are space-joined, never fused", () => {
    // The "Log inContinue with Google" class of bug: sibling inline text
    // with no whitespace between the elements.
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    document.body.innerHTML =
      `<a id="a" href="/x"><span>Log in</span><span>Sign up</span></a>`;
    const props = clickAndRead(document.getElementById("a")!, ctx);
    expect(props?.text).toBe("Log in Sign up");
    expect(props?.text).not.toContain("inSign");
  });

  it("a content-block link resolves to its heading, not the whole block", () => {
    // The "Tudo que você é,em um só link.Portfolio…" bug: a hero <a>
    // wrapping a heading + paragraph + list.
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    document.body.innerHTML =
      `<a id="hero" href="/pt">` +
      `<h1>Tudo que você é, em um só link</h1>` +
      `<p>Portfolio, loja, redes sociais.</p>` +
      `<ul><li>one</li><li>two</li></ul>` +
      `</a>`;
    const props = clickAndRead(document.querySelector("#hero h1")!, ctx);
    expect(props?.text).toBe("Tudo que você é, em um só link");
    expect(props?.text).not.toContain("Portfolio");
  });

  it("a wrapper around multiple controls does not mash their labels", () => {
    // The actionable ancestor is the role=button wrapper; its descendant
    // buttons must not be concatenated into the label.
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    document.body.innerHTML =
      `<div id="card" role="button">` +
      `<button>Continue with Google</button>` +
      `<button>Continue with Apple</button>` +
      `</div>`;
    const props = clickAndRead(document.getElementById("card")!, ctx);
    // No clean own-label → falls through to selector; text is absent, and
    // critically never the mashed concatenation.
    expect(props?.text ?? "").not.toContain("Continue with GoogleContinue");
    expect(props?.text ?? "").not.toContain("Continue with Apple");
  });

  it("clicking a control inside the wrapper resolves to that control", () => {
    // The realistic path: the click lands ON one button; closestActionable
    // stops at it, so the label is clean.
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    document.body.innerHTML =
      `<div role="button"><button id="g">Continue with Google</button></div>`;
    const props = clickAndRead(document.getElementById("g")!, ctx);
    expect(props?.text).toBe("Continue with Google");
  });

  it("aria-label still wins over descendant text", () => {
    const ctx = makeContext();
    newTracker({}, ctx.track).install();
    document.body.innerHTML =
      `<button id="b" aria-label="Close dialog"><span>×</span></button>`;
    const props = clickAndRead(document.getElementById("b")!, ctx);
    expect(props?.text).toBe("Close dialog");
  });
});

// ============================================================
// Event Envelope v1 §3 — per-session monotonic seq counter
// ============================================================

describe("AutoTracker — nextSeq() (Envelope v1 §3)", () => {
  it("starts at 0 for the first event of a new session", () => {
    const ctx = makeContext();
    const t = newTracker({ sessions: false, pageViews: false }, ctx.track);
    t.install();
    // Manually prime a session (no sessions auto-track so we fake it)
    t.resetSession();
    // First call returns 0
    expect(t.nextSeq()).toBe(0);
  });

  it("increments monotonically within a session", () => {
    const ctx = makeContext();
    const t = newTracker({ sessions: false, pageViews: false }, ctx.track);
    t.install();
    t.resetSession();
    expect(t.nextSeq()).toBe(0);
    expect(t.nextSeq()).toBe(1);
    expect(t.nextSeq()).toBe(2);
  });

  it("resets to 0 on resetSession() (new session boundary)", () => {
    const ctx = makeContext();
    const t = newTracker({ sessions: false, pageViews: false }, ctx.track);
    t.install();
    t.resetSession();
    t.nextSeq(); // 0
    t.nextSeq(); // 1
    t.nextSeq(); // 2
    t.resetSession(); // new session — counter resets
    expect(t.nextSeq()).toBe(0); // back to 0
  });

  it("counter is independent of session presence — starts at 0 on construction", () => {
    // The counter field initialises to 0; the first call always returns 0
    // even without a session (matches crossdeck.ts fallback path).
    const ctx = makeContext();
    const t = new AutoTracker(
      { ...DEFAULT_AUTO_TRACK, sessions: false, pageViews: false },
      ctx.track,
    );
    // Not installed, no session set up
    expect(t.nextSeq()).toBe(0);
    expect(t.nextSeq()).toBe(1); // increments monotonically
  });
});
