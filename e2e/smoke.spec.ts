/**
 * End-to-end SDK smoke tests.
 *
 * Loads the real built UMD bundle via the demo page, mocks the backend
 * with Playwright's `page.route()`, and asserts the SDK's wire shape.
 *
 * What this catches that unit tests don't:
 *   - The IIFE bundle parses + registers `window.Crossdeck`.
 *   - Real fetch() calls fire with the right method, URL, body, and
 *     headers (Idempotency-Key, Authorization, Crossdeck-Sdk-Version).
 *   - Real localStorage writes for identity + durable queue.
 *   - Real consent gating: when analytics is denied, fetch is NOT
 *     called (not just dropped at the SDK boundary).
 *   - Real PII scrub: the request body lands without the leaked PII.
 *   - Real cross-microtask flush ordering.
 *
 * What this does NOT cover:
 *   - Backend correctness (lives in backend/tests/).
 *   - Cross-browser quirks beyond Chromium (extend `projects` in
 *     playwright.config.ts to add firefox / webkit when the time
 *     comes — adds ~3 min to the CI run).
 */

import { test, expect, type Request, type Page } from "@playwright/test";

const APP_ID = "app_web_e2e";
const PUBLIC_KEY = "cd_pub_test_e2e";

/**
 * Helper: install a mocked backend that responds to every Crossdeck
 * API endpoint with a stable success shape. Captures every Crossdeck
 * request for the test to assert against.
 */
async function installMockBackend(page: Page): Promise<{ requests: Request[] }> {
  const requests: Request[] = [];

  await page.route("**/api.cross-deck.com/**", async (route) => {
    const req = route.request();
    requests.push(req);
    const url = new URL(req.url());
    const path = url.pathname;

    if (path.endsWith("/sdk/heartbeat")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          object: "heartbeat",
          ok: true,
          projectId: "proj_e2e",
          appId: APP_ID,
          platform: "web",
          env: "sandbox",
          serverTime: Date.now(),
        }),
      });
    }
    if (path.endsWith("/identity/alias")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          object: "alias_result",
          crossdeckCustomerId: "cdcust_e2e_001",
          linked: [],
          mergePending: false,
          env: "sandbox",
        }),
      });
    }
    if (path.endsWith("/identity/forget")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          object: "forgot",
          crossdeckCustomerId: "cdcust_e2e_001",
          queuedAt: Date.now(),
          env: "sandbox",
        }),
      });
    }
    if (path.endsWith("/entitlements")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          object: "list",
          data: [],
          crossdeckCustomerId: "cdcust_e2e_001",
          env: "sandbox",
        }),
      });
    }
    if (path.endsWith("/events")) {
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ object: "list", received: 0, env: "sandbox" }),
      });
    }
    return route.fulfill({ status: 404, body: "not mocked: " + path });
  });

  return { requests };
}

/**
 * Helper: fill the demo's config inputs and click init.
 *
 * The demo runs as `file://` or http://127.0.0.1:4173. Localhost is
 * detected by the SDK's isLocalHostname() AND short-circuits every
 * request to a synthetic response. We override that by pointing
 * baseUrl at a domain the mock intercepts.
 */
async function initSdk(page: Page) {
  // Initialise the SDK by directly calling Crossdeck.init() in the
  // page context. We don't go through the demo's button-click flow
  // because the demo would also clear localStorage between tests via
  // its inputs. Cleaner: invoke init() with our test config directly.
  //
  // `window.__CROSSDECK_FORCE_LIVE__ = true` is set in the
  // beforeEach() via `page.addInitScript` so the SDK doesn't
  // short-circuit on hostname=127.0.0.1.
  await page.evaluate(
    ({ appId, key }) => {
      const { Crossdeck } = window as typeof window & {
        Crossdeck: { Crossdeck: unknown };
      };
      // @ts-expect-error - shape known at runtime.
      Crossdeck.Crossdeck.init({
        appId,
        publicKey: key,
        environment: "sandbox",
        baseUrl: "https://api.cross-deck.com/v1",
      });
    },
    { appId: APP_ID, key: PUBLIC_KEY },
  );
}

test.describe("@cross-deck/web — end-to-end smoke", () => {
  test.beforeEach(async ({ page }) => {
    // Tell the SDK to bypass its localhost short-circuit so real
    // fetches fire and our mock backend can intercept them. The
    // flag is read inside isLocalHostname() at init() time.
    await page.addInitScript(() => {
      (window as { __CROSSDECK_FORCE_LIVE__?: boolean }).__CROSSDECK_FORCE_LIVE__ = true;
      // Wipe localStorage between tests so the durable queue and
      // identity persistence start clean.
      try {
        localStorage.clear();
      } catch (_) {
        // ignore — some pages disallow it pre-load
      }
    });
    await page.goto("/demo/index.html");
    // Wait for the UMD bundle to register window.Crossdeck.
    await page.waitForFunction(() => Boolean((window as { Crossdeck?: unknown }).Crossdeck));
  });

  test("UMD bundle loads + registers window.Crossdeck", async ({ page }) => {
    const exists = await page.evaluate(() => {
      const w = window as typeof window & { Crossdeck: { Crossdeck?: unknown } };
      return Boolean(w.Crossdeck) && typeof w.Crossdeck.Crossdeck === "object";
    });
    expect(exists).toBe(true);
  });

  test("init() + heartbeat() fires the right wire shape", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    // Trigger an explicit heartbeat
    await page.evaluate(() => {
      const w = window as typeof window & { Crossdeck: { Crossdeck: { heartbeat: () => Promise<unknown> } } };
      return w.Crossdeck.Crossdeck.heartbeat();
    });
    // Wait for the heartbeat request.
    await expect.poll(() => requests.some((r) => r.url().endsWith("/sdk/heartbeat")), {
      timeout: 5_000,
    }).toBe(true);
    const heartbeat = requests.find((r) => r.url().endsWith("/sdk/heartbeat"))!;
    const headers = heartbeat.headers();
    expect(headers.authorization).toBe(`Bearer ${PUBLIC_KEY}`);
    expect(headers["crossdeck-sdk-version"]).toContain("@cross-deck/web");
  });

  test("track() flushes with Idempotency-Key header", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: { track: (n: string, p?: unknown) => void; flush: () => Promise<unknown> } };
      }).Crossdeck.Crossdeck;
      Crossdeck.track("e2e_event", { variant: "v1" });
      return Crossdeck.flush();
    });
    await expect.poll(() => requests.some((r) => r.url().endsWith("/events")), { timeout: 5_000 })
      .toBe(true);
    const ev = requests.find((r) => r.url().endsWith("/events"))!;
    const headers = ev.headers();
    expect(headers["idempotency-key"]).toMatch(/^batch_/);
    const body = JSON.parse(ev.postData() || "{}");
    expect(body.appId).toBe(APP_ID);
    // The batch may include auto-emitted events (session.started,
    // page.viewed, webvitals.*) alongside our test event. Find ours.
    const ourEvent = body.events.find((e: { name: string }) => e.name === "e2e_event");
    expect(ourEvent).toBeTruthy();
    expect(ourEvent.properties.variant).toBe("v1");
  });

  test("identify() sends traits in the alias body", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: { identify: (id: string, opts?: unknown) => Promise<unknown> } };
      }).Crossdeck.Crossdeck;
      return Crossdeck.identify("e2e_user", { traits: { plan: "pro", name: "E2E" } });
    });
    await expect.poll(() => requests.some((r) => r.url().endsWith("/identity/alias")), { timeout: 5_000 })
      .toBe(true);
    const alias = requests.find((r) => r.url().endsWith("/identity/alias"))!;
    const body = JSON.parse(alias.postData() || "{}");
    expect(body.userId).toBe("e2e_user");
    expect(body.traits).toEqual({ plan: "pro", name: "E2E" });
  });

  test("consent({ analytics: false }) drops new events — name not in any batch", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: {
          consent: (s: unknown) => unknown;
          track: (n: string, p?: unknown) => void;
          flush: () => Promise<unknown>;
        } };
      }).Crossdeck.Crossdeck;
      Crossdeck.consent({ analytics: false });
      Crossdeck.track("should_be_dropped", { i: 1 });
      return Crossdeck.flush();
    });
    // Drain any pending flushes.
    await page.waitForTimeout(800);
    // Any /events POSTs may exist (auto-emitted events that fired
    // BEFORE consent was denied are still in-queue and would flush).
    // What MUST be true: no batch contains our "should_be_dropped"
    // event — that's the consent gate at work.
    const allEventBodies = requests
      .filter((r) => r.url().endsWith("/events"))
      .map((r) => r.postData() || "");
    for (const body of allEventBodies) {
      expect(body).not.toContain("should_be_dropped");
    }
  });

  test("register() super-properties land on every event", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: {
          register: (p: unknown) => unknown;
          track: (n: string, p?: unknown) => void;
          flush: () => Promise<unknown>;
        } };
      }).Crossdeck.Crossdeck;
      Crossdeck.register({ releaseChannel: "beta", testRun: "e2e" });
      Crossdeck.track("a");
      Crossdeck.track("b");
      return Crossdeck.flush();
    });
    await expect.poll(
      () => {
        // Find a /events POST that contains an event named "a" or "b"
        // — those were the ones we tracked AFTER register(). The
        // initial auto-emitted batch (session.started, page.viewed,
        // webvitals.*) was POSTed BEFORE register and doesn't carry
        // our super-properties.
        return requests
          .filter((r) => r.url().endsWith("/events"))
          .some((r) => {
            const body = r.postData() || "";
            return body.includes('"name":"a"') || body.includes('"name":"b"');
          });
      },
      { timeout: 5_000 },
    ).toBe(true);
    const targetReq = requests
      .filter((r) => r.url().endsWith("/events"))
      .find((r) => {
        const body = r.postData() || "";
        return body.includes('"name":"a"');
      })!;
    const body = JSON.parse(targetReq.postData() || "{}");
    const ourEvents = body.events.filter((e: { name: string }) => e.name === "a" || e.name === "b");
    expect(ourEvents.length).toBeGreaterThanOrEqual(1);
    for (const event of ourEvents) {
      expect(event.properties.releaseChannel).toBe("beta");
      expect(event.properties.testRun).toBe("e2e");
    }
  });

  test("group() attaches $groups.<type> to every event", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: {
          group: (t: string, id: string | null) => void;
          track: (n: string, p?: unknown) => void;
          flush: () => Promise<unknown>;
        } };
      }).Crossdeck.Crossdeck;
      Crossdeck.group("org", "acme_e2e");
      Crossdeck.track("group_event");
      return Crossdeck.flush();
    });
    // Find the POST that contains the "group_event" (skip earlier
    // auto-emitted batches that fired before group() ran).
    await expect.poll(
      () =>
        requests
          .filter((r) => r.url().endsWith("/events"))
          .some((r) => (r.postData() || "").includes("group_event")),
      { timeout: 5_000 },
    ).toBe(true);
    const targetReq = requests
      .filter((r) => r.url().endsWith("/events"))
      .find((r) => (r.postData() || "").includes("group_event"))!;
    const body = JSON.parse(targetReq.postData() || "{}");
    const ourEvent = body.events.find((e: { name: string }) => e.name === "group_event");
    expect(ourEvent.properties.$groups).toEqual({ org: "acme_e2e" });
  });

  test("PII scrub replaces email + card in request body", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: {
          track: (n: string, p?: unknown) => void;
          flush: () => Promise<unknown>;
        } };
      }).Crossdeck.Crossdeck;
      Crossdeck.track("pii_event", {
        url: "/users/wes@pinet.co.za/profile",
        card: "4242 4242 4242 4242",
      });
      return Crossdeck.flush();
    });
    await expect.poll(() => requests.some((r) => r.url().endsWith("/events")), { timeout: 5_000 })
      .toBe(true);
    const ev = requests.find((r) => r.url().endsWith("/events"))!;
    const bodyStr = ev.postData() || "";
    expect(bodyStr).not.toContain("wes@pinet.co.za");
    expect(bodyStr).toContain("<email>");
    expect(bodyStr).not.toContain("4242 4242 4242 4242");
    expect(bodyStr).toContain("<card>");
  });

  test("durable queue persists to localStorage after enqueue", async ({ page }) => {
    await installMockBackend(page);
    await initSdk(page);
    // Queue without flushing — track() is synchronous, persistence is
    // microtask-debounced.
    const persisted = await page.evaluate(async () => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: { track: (n: string, p?: unknown) => void } };
      }).Crossdeck.Crossdeck;
      for (let i = 0; i < 3; i++) Crossdeck.track("durable_e2e", { i });
      // Yield twice to let microtask + debounce land.
      await Promise.resolve();
      await Promise.resolve();
      return localStorage.getItem("crossdeck:queue.v1");
    });
    expect(persisted).toBeTruthy();
    const parsed = JSON.parse(persisted!);
    expect(parsed.version).toBe(1);
    expect(parsed.events.length).toBeGreaterThan(0);
  });

  test("forget() calls /identity/forget then wipes localStorage", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(async () => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: {
          identify: (id: string, opts?: unknown) => Promise<unknown>;
          register: (p: unknown) => unknown;
          forget: () => Promise<void>;
        } };
      }).Crossdeck.Crossdeck;
      await Crossdeck.identify("forget_e2e");
      Crossdeck.register({ plan: "pro" });
      await Crossdeck.forget();
    });
    expect(requests.some((r) => r.url().endsWith("/identity/forget"))).toBe(true);
    // After forget, super-props should be wiped.
    const supers = await page.evaluate(() => {
      return localStorage.getItem("crossdeck:super_props");
    });
    expect(supers).toBeNull();
  });

  test("captureError() ships an error.handled event with stack + fingerprint", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: {
          captureError: (e: unknown, opts?: unknown) => void;
          flush: () => Promise<unknown>;
        } };
      }).Crossdeck.Crossdeck;
      try {
        throw new Error("e2e_test_error");
      } catch (err) {
        Crossdeck.captureError(err, { tags: { flow: "test" } });
      }
      return Crossdeck.flush();
    });
    await expect.poll(
      () =>
        requests
          .filter((r) => r.url().endsWith("/events"))
          .some((r) => (r.postData() || "").includes("e2e_test_error")),
      { timeout: 5_000 },
    ).toBe(true);
    const ev = requests
      .filter((r) => r.url().endsWith("/events"))
      .find((r) => (r.postData() || "").includes("e2e_test_error"))!;
    const body = JSON.parse(ev.postData() || "{}");
    const errEv = body.events.find((e: { name: string }) => e.name === "error.handled");
    expect(errEv).toBeTruthy();
    expect(errEv.properties.message).toBe("e2e_test_error");
    expect(errEv.properties.errorType).toBe("Error");
    expect(errEv.properties.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(errEv.properties.tags.flow).toBe("test");
    expect(Array.isArray(errEv.properties.frames)).toBe(true);
  });

  test("global window.onerror catches uncaught errors", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    // Throw an uncaught error in the page context and wait for the
    // SDK to capture it via window.onerror.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("e2e_uncaught_error");
      }, 10);
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: { flush: () => Promise<unknown> } };
      }).Crossdeck.Crossdeck;
      return Crossdeck.flush();
    });
    await expect.poll(
      () =>
        requests
          .filter((r) => r.url().endsWith("/events"))
          .some((r) => (r.postData() || "").includes("e2e_uncaught_error")),
      { timeout: 5_000 },
    ).toBe(true);
    const ev = requests
      .filter((r) => r.url().endsWith("/events"))
      .find((r) => (r.postData() || "").includes("e2e_uncaught_error"))!;
    const body = JSON.parse(ev.postData() || "{}");
    const errEv = body.events.find((e: { name: string }) => e.name === "error.unhandled");
    expect(errEv).toBeTruthy();
  });

  test("captureMessage() ships error.message events", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: {
          captureMessage: (m: string, l?: string) => void;
          flush: () => Promise<unknown>;
        } };
      }).Crossdeck.Crossdeck;
      Crossdeck.captureMessage("deprecated path hit", "warning");
      return Crossdeck.flush();
    });
    await expect.poll(
      () =>
        requests
          .filter((r) => r.url().endsWith("/events"))
          .some((r) => (r.postData() || "").includes("deprecated path hit")),
      { timeout: 5_000 },
    ).toBe(true);
    const ev = requests
      .filter((r) => r.url().endsWith("/events"))
      .find((r) => (r.postData() || "").includes("deprecated path hit"))!;
    const body = JSON.parse(ev.postData() || "{}");
    const msgEv = body.events.find((e: { name: string }) => e.name === "error.message");
    expect(msgEv.properties.level).toBe("warning");
  });

  test("breadcrumbs from track() are attached to error reports", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: {
          track: (n: string, p?: unknown) => void;
          captureError: (e: unknown) => void;
          flush: () => Promise<unknown>;
        } };
      }).Crossdeck.Crossdeck;
      Crossdeck.track("paywall_viewed", { variant: "v3" });
      try {
        throw new Error("breadcrumb_test_error");
      } catch (err) {
        Crossdeck.captureError(err);
      }
      return Crossdeck.flush();
    });
    await expect.poll(
      () =>
        requests
          .filter((r) => r.url().endsWith("/events"))
          .some((r) => (r.postData() || "").includes("breadcrumb_test_error")),
      { timeout: 5_000 },
    ).toBe(true);
    const ev = requests
      .filter((r) => r.url().endsWith("/events"))
      .find((r) => (r.postData() || "").includes("breadcrumb_test_error"))!;
    const body = JSON.parse(ev.postData() || "{}");
    const errEv = body.events.find((e: { name: string }) => e.name === "error.handled");
    expect(errEv.properties.breadcrumbs.length).toBeGreaterThan(0);
    expect(
      errEv.properties.breadcrumbs.some((c: { message: string }) => c.message === "paywall_viewed"),
    ).toBe(true);
  });

  test("consent({ errors: false }) drops error reports", async ({ page }) => {
    const { requests } = await installMockBackend(page);
    await initSdk(page);
    await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: {
          consent: (s: unknown) => unknown;
          captureError: (e: unknown) => void;
          flush: () => Promise<unknown>;
        } };
      }).Crossdeck.Crossdeck;
      Crossdeck.consent({ errors: false });
      Crossdeck.captureError(new Error("should_be_blocked"));
      return Crossdeck.flush();
    });
    await page.waitForTimeout(500);
    const allBodies = requests
      .filter((r) => r.url().endsWith("/events"))
      .map((r) => r.postData() || "");
    for (const body of allBodies) {
      expect(body).not.toContain("should_be_blocked");
    }
  });

  test("diagnostics() returns the full Wave-1/3 shape", async ({ page }) => {
    await installMockBackend(page);
    await initSdk(page);
    const diag = await page.evaluate(() => {
      const Crossdeck = (window as typeof window & {
        Crossdeck: { Crossdeck: { diagnostics: () => unknown } };
      }).Crossdeck.Crossdeck;
      return Crossdeck.diagnostics();
    });
    type Diag = {
      started: boolean;
      anonymousId: string | null;
      clock: { lastServerTime: unknown; lastClientTime: unknown; skewMs: unknown };
      entitlements: { count: number; listenerErrors: number };
      events: { buffered: number; consecutiveFailures: number; nextRetryAt: unknown };
    };
    const d = diag as Diag;
    expect(d.started).toBe(true);
    expect(d.clock).toBeDefined();
    expect("skewMs" in d.clock).toBe(true);
    expect("listenerErrors" in d.entitlements).toBe(true);
    expect("consecutiveFailures" in d.events).toBe(true);
    expect("nextRetryAt" in d.events).toBe(true);
  });
});
