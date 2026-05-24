# `@cross-deck/web` release checklist

Procedural gate before every `npm publish`. Every box must be ticked or
the publish does not happen. Stripe-grade discipline — SDK regressions
break customer dashboards silently.

The checklist is split into automated gates (run them and read the
output) and manual gates (open a browser and look).

---

## 0. Pre-flight

- [ ] CHANGELOG has an entry for the version you're about to ship. The
      version in `package.json`, `src/http.ts:SDK_VERSION`, and the
      heading in `CHANGELOG.md` all match.
- [ ] `sdks/SDK_TRUTH.md` is updated for every new public API or
      changed default. (Audit script — step 2.3 — will catch drift,
      but write the section first so the diff is small.)
- [ ] Every new error code is in `src/error-codes.ts` with
      `description` + `resolution` + `retryable`.

## 1. Automated gates

Run from `sdks/web/`:

```bash
npm run lint              # tsc --noEmit on src + tests
npm test                  # 260+ unit tests; covers every module
npm run build             # tsup + emit-error-codes
npm run size              # gzip-byte budget check
npm run test:e2e          # Playwright against the built dist/
```

Or in one shot, simulating exactly what `npm publish` would do:

```bash
npm run prepublishOnly
```

All five must exit zero. If any one fails, do NOT publish.

### 1.1 Unit tests (`npm test`)

- Should report ≥ 260 tests, all green.
- Look for any new `it.skip(...)` or `describe.skip(...)` that crept
  in — those are tech debt, not passing tests.
- Coverage report optional but recommended: `npm run test:coverage`.
  Hot-path modules (`crossdeck.ts`, `event-queue.ts`, `http.ts`,
  `consent.ts`, `event-validation.ts`) should sit ≥ 90%.

### 1.2 Bundle-size budget (`npm run size`)

- Core ESM ≤ 28 KB gz
- Core CJS ≤ 28 KB gz
- React ESM ≤ 28 KB gz
- Vue ESM ≤ 28 KB gz
- UMD minified ≤ 16 KB gz

If a new feature pushes a budget, decide:
- Is the feature load-bearing? (yes → bump the budget in
  `scripts/check-bundle-size.mjs` AND add a CHANGELOG note explaining
  why).
- No? (trim the feature, or move it behind a dynamic import).

### 1.3 E2E (`npm run test:e2e`)

- 11 Chromium tests, all green.
- Tests load the real built `dist/crossdeck.umd.min.js` — proves the
  publish artefact actually works in a real browser, not just the
  source under Vitest's jsdom.
- For cross-browser confidence, add `firefox` / `webkit` to
  `playwright.config.ts` `projects` and re-run (adds ~3 min).

### 1.4 Audit script (`node scripts/audit-sdk-snippets.mjs` from repo root)

- Run from the repo root, not the SDK dir.
- Catches: stale snippet drift, banned patterns leaking outside
  `_sdk-snippets.js` (`await Crossdeck.isEntitled`,
  `cd_pub_sandbox_`, hardcoded `user_123`, etc.).

## 2. Manual smoke checks

### 2.1 Open the demo page

```bash
cd sdks/web && npx http-server -p 4173 -c-1 .
```

Then open `http://127.0.0.1:4173/demo/index.html`.

In the page, paste an App ID + publishable key from a real Crossdeck
project, pick the right environment, and click through:

1. **`init()` + `getEntitlements()`** — sidebar `Diagnostics` panel
   should populate. `started: true`, `anonymousId` set.
2. **`identify()` with traits** — Network tab shows `/v1/identity/alias`
   POST with `traits` in the body.
3. **`track('paywall_viewed')`** — Network tab shows `/v1/events` POST
   with `Idempotency-Key: batch_…` header.
4. **`track() with poison properties`** — payload should contain
   sanitised values (no functions, BigInt→string, Date→ISO).
5. **`register({ plan: 'pro' })` + `track()`** — payload includes `plan: 'pro'`.
6. **`group('org', 'acme')` + `track()`** — payload includes `$groups.org`.
7. **`track() with PII`** — Network body should show `<email>` and
   `<card>`, not the raw values. Tokens are angle-bracketed (aligned
   with the backend's defence-in-depth scrubber); a `[email]` /
   `[card]` sentinel in the body means an out-of-date SDK build.
8. **`consent({ analytics: false })` + `track()`** — Network tab shows
   NO new `/events` POST.
9. **Queue 5 events** (no flush) — DevTools → Application → Local
   Storage shows `crossdeck:queue.v1` with 5 entries.
10. **Close the tab and re-open the demo** (with the same SDK config) —
    those 5 events should rehydrate and flush automatically.
11. **`Simulate offline + retry`** — diagnostics panel's
    `consecutiveFailures` increments; `nextRetryAt` is in the future.
12. **`forget()`** — `/v1/identity/forget` POST fires; localStorage is
    wiped.

### 2.2 React subpackage spot-check

In a scratch CRA / Next.js / Vite-React app, install the locally-built
tarball (`npm pack` produces it) and confirm:

```tsx
import { useEntitlement } from "@cross-deck/web/react";
function Badge() {
  const isPro = useEntitlement("pro");
  return isPro ? <span>Pro</span> : null;
}
```

- TypeScript compiles.
- The component re-renders on cache mutation.

### 2.3 Vue subpackage spot-check

Same in a Vue 3 scratch project:

```vue
<script setup>
import { useEntitlement } from "@cross-deck/web/vue";
const isPro = useEntitlement("pro");
</script>
```

- TypeScript compiles.
- Ref updates on cache mutation.

## 3. Dry-run publish

```bash
cd sdks/web
npm publish --dry-run
```

Read the file list output. Verify:
- `dist/index.{cjs,mjs}`, `dist/index.d.{ts,mts}`
- `dist/react.{cjs,mjs}`, `dist/react.d.{ts,mts}`
- `dist/vue.{cjs,mjs}`, `dist/vue.d.{ts,mts}`
- `dist/crossdeck.umd.min.js` + `.map`
- `dist/error-codes.json`
- `README.md`, `CHANGELOG.md`, `LICENSE`
- `package.json`

Should NOT include:
- `tests/`, `e2e/`, `demo/`, `scripts/`, `tsconfig.json`,
  `tsup.config.ts`, `playwright.config.ts`, `node_modules/`,
  `RELEASE_CHECKLIST.md`
- Anything from the repo root (the SDK package is published from
  `sdks/web/`, not from the monorepo root).

If something extraneous is in the tarball, fix the `files` array in
`package.json` before publishing.

## 4. Publish

```bash
cd sdks/web
npm whoami                  # confirm logged in to the right account
npm publish --access public
```

`prepublishOnly` re-runs lint + test + build + size + e2e
automatically, so a clean dry-run almost guarantees a clean publish.
If anything fails, the publish is aborted before the upload — no
partial state on npm.

## 5. Post-publish verification

```bash
# Wait ~30s for npm CDN propagation, then:
npm view @cross-deck/web@<version> dist
```

- The `tarball` URL should resolve. Click it; should download the
  exact tarball you dry-ran.
- The `unpkg` field (in `package.json` you just shipped) means
  `https://unpkg.com/@cross-deck/web@<version>/dist/crossdeck.umd.min.js`
  is now live. Open it in a browser; it should be the minified IIFE.

## 6. Update consumers

- Bump `@cross-deck/web` in `package.json` for every Crossdeck-owned
  property running it (the dashboard, the docs hot demos, Biotree if
  dogfooding). Run `npm install`, redeploy.
- Watch the Sentry / production error feed for ~1 hour after deploy.
  Wave 1's retry + backoff means transient errors stop reaching
  Sentry; a sudden spike in something new means a regression.

---

## What this checklist catches that "all tests pass" doesn't

| Class of bug                                     | Caught by                              |
| ------------------------------------------------ | -------------------------------------- |
| Source bug in a module                           | Unit tests                             |
| Bundling breaks the `exports` map                | `npm run build` + `dist-loading.test.ts` |
| Wire shape regresses (Idempotency-Key dropped, etc.) | E2E tests + manual demo check          |
| Bundle bloated past customer-acceptable size     | `npm run size`                         |
| Stale snippet text published in docs / homepage  | `scripts/audit-sdk-snippets.mjs`       |
| Tarball ships test fixtures by accident          | `npm publish --dry-run`                |
| Real browser quirks (Safari ITP, Firefox cookie) | Manual demo + cross-browser E2E run    |
| SDK_TRUTH drift                                  | Manual review of CHANGELOG vs SDK_TRUTH |

If you find a class of bug not in the table above and not caught by
this checklist, add it. The checklist gets tighter every release.
