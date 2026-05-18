import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for end-to-end SDK tests.
 *
 * The tests load the real built artefact (dist/crossdeck.umd.min.js)
 * via the demo page (demo/index.html) and intercept fetch() with
 * Playwright routes to assert SDK behaviour without a live backend.
 *
 * Why mocked backend rather than real:
 *   - CI shouldn't depend on api.cross-deck.com uptime.
 *   - Tests assert SDK shape (Idempotency-Key header, consent gating,
 *     PII scrub in request body, retry on 5xx, etc.) — backend
 *     contract tests live in backend/tests/ instead.
 *   - Real-backend smoke testing is what the demo page is for —
 *     the founder runs it manually before publishing.
 *
 * The web server is a plain `npx serve` of the SDK package root so
 * paths like `/demo/index.html` and `/dist/crossdeck.umd.min.js`
 * resolve correctly (the demo's <script src="../dist/..."> needs
 * `/dist` to exist at the URL root, which means we serve from
 * sdks/web/ rather than sdks/web/demo/).
 */

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // each test mutates localStorage globally; serial keeps the dependencies obvious
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Use a tiny static server. http-server is zero-config and ships
    // with npm's binary cache via npx. Serve from the SDK package
    // root so /dist and /demo resolve cleanly relative to the
    // demo page's <script src="../dist/..."> relative path.
    command: "npx --yes http-server -p 4173 -c-1 --silent .",
    url: "http://127.0.0.1:4173/demo/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
