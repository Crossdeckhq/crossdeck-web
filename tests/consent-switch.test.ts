/**
 * @vitest-environment jsdom
 *
 * Crossdeck Consent — the light switch (CD-185).
 *
 * The contract this guards:
 *   1. OFF by default — a plain init() renders no widget and leaves consent
 *      untouched. The widget is a feature, never a tax on every install.
 *   2. ON with one flag — `consentBanner: true` mounts the branded banner.
 *   3. Consent-FIRST — switching it on denies analytics/marketing until the
 *      visitor chooses. A banner that gates nothing is the lawsuit, not the fix.
 *   4. ENFORCEMENT is core either way — `consent()` is always the socket an
 *      external CMP plugs into, with no opt-in required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CrossdeckClient } from "../src/crossdeck";

const OPTS = {
  appId: "app_web_test",
  publicKey: "cd_pub_test_switch",
  environment: "sandbox" as const,
};

/** The widget mounts async (dynamic import); give the microtask queue a beat. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 50));
}

/** Any shadow-DOM host the banner attached to the document. */
function widgetHosts(): Element[] {
  return Array.from(document.querySelectorAll("[data-crossdeck-consent-host]"));
}

describe("consent light switch", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is OFF by default — no widget, no forced denial", async () => {
    const c = new CrossdeckClient();
    c.init(OPTS);
    await settle();
    expect(widgetHosts()).toHaveLength(0);
  });

  it("mounts the banner when the switch is flipped (policy URL = the switch)", async () => {
    const c = new CrossdeckClient();
    c.init({ ...OPTS, consentBanner: "https://example.com/privacy" });
    await settle();
    expect(widgetHosts().length).toBeGreaterThan(0);
  });

  it("denies analytics + marketing until the visitor chooses", async () => {
    const c = new CrossdeckClient();
    c.init({ ...OPTS, consentBanner: "https://example.com/privacy" });
    await settle();
    const state = c.consent({});
    expect(state.analytics).toBe(false);
    expect(state.marketing).toBe(false);
  });

  it("accepts an options object as well as `true`", async () => {
    const c = new CrossdeckClient();
    c.init({
      ...OPTS,
      consentBanner: { policyUrl: "https://example.com/privacy" },
    });
    await settle();
    expect(widgetHosts().length).toBeGreaterThan(0);
  });

  it("enforcement is core — consent() works with the switch OFF", () => {
    const c = new CrossdeckClient();
    c.init(OPTS);
    const state = c.consent({ analytics: false });
    expect(state.analytics).toBe(false);
  });
});
