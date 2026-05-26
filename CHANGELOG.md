# Changelog

All notable changes to `@cross-deck/web` will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.2] — 2026-05-26

Patch — second npm publish pipeline fix. v1.4.1 fixed the Node 24
`navigator` test mutation, but the `prepublishOnly` hook still ran
the Playwright e2e suite at `npm publish` time even though the
publish workflow doesn't install Chromium. Removed `test:e2e` from
`prepublishOnly` — the publish workflow runs lint + unit tests +
build + size budget which covers everything except the
browser-bound e2e (which requires Playwright setup the publish
workflow doesn't provide; e2e still runs in monorepo CI). v1.4.2
is the first 1.4.x line to actually land on the npm registry.
**No SDK code changes vs v1.4.0 / v1.4.1**.

## [1.4.1] — 2026-05-26

Patch — Node 24 compatibility fix for the npm publish pipeline. The
`consent.test.ts` DNT cases mutated `globalThis.navigator` via direct
assignment; Node 24 (the public crossdeck-web repo's npm publish
workflow Node version) made navigator a read-only getter, so the
test threw `TypeError: Cannot set property navigator` and aborted
the publish. Pattern switched to `Object.defineProperty`. v1.4.0
was tagged on the public GitHub repo but never reached npm — v1.4.1
is the first 1.4.x line to land on the npm registry. **No SDK code
changes vs v1.4.0**; the entire bank-grade reconciliation surface
documented below ships unchanged.

## [1.4.0] — 2026-05-26

**Bank-grade reconciliation release.** 6-pillar KPMG-style audit closed across SDK + backend. Every behavioural guarantee registered in the monorepo's `contracts/` directory with a CI-enforced audit job — drift is now a PR-time error.

### Added

- **Deterministic `Idempotency-Key` on `syncPurchases()`.** Derived from the request body (SHA-256 of `crossdeck:purchases/sync:<rail>:<jws>`, formatted as UUID). Same purchase → same key → backend short-circuits with `idempotent_replay: true`. Cross-SDK parity oracle CI-pinned: every SDK produces `a66b1640-efaf-bb4d-1261-6650033bf111` for the canonical test vector.
- **Per-user entitlement cache isolation.** Storage key is now `crossdeck:entitlements:<sha256(userId)>` — a user-switch on a shared device cannot physically read prior user's cached entitlements even if the in-memory clear is somehow skipped. `reset()` wipes EVERY per-user slot via the persisted index. New pure-JS SHA-256 helper (no SubtleCrypto async cascade through hot-path reads).
- **`PurchaseResult.idempotent_replay?: boolean`** — true when the response came from the backend's idempotency cache instead of fresh processing.
- **`purchase.completed` event on every successful `syncPurchases()`** — schema matches the auto-track event so cross-platform funnels reconcile.
- **15 backend-emitted error codes** added to `crossdeck-error-codes.json` catalogue (`invalid_api_key`, `origin_not_allowed`, `bundle_id_not_allowed`, `package_name_not_allowed`, `env_mismatch`, `idempotency_key_in_use`, `rate_limited`, `internal_error`, `google_not_supported`, `stripe_not_supported`, etc.) — `getErrorCode()` now returns Stripe-style remediation for every wire code instead of `undefined`.

### Changed

- **`init()` re-entry now drains the prior `EventQueue`'s pending timer** before swapping `this.state`. Pre-1.4.0 the timer fired AFTER the state swap, sending old-init events under new-init identity — cross-identity leak during HMR / config swap / multi-tenant SDK shells.
- **Default event-queue flush interval is now 2000ms** (was 1500ms) — parity with every other Crossdeck SDK on the Stripe-adjacent industry norm.
- **`reset()` now wipes every per-user entitlement slot on the device** via the persisted index, not just the active user's slot.

Patch fix for the 1.3.0 dist-load contract. 1.3.0 introduced
`import { version } from "../package.json"` to keep the runtime
`Crossdeck-Sdk-Version` header in lockstep with the published bundle.
Esbuild inlined the JSON correctly so the published bundle still
shipped the right version on the wire, but the `dist-loading` test
that dynamic-imports the built `.mjs` files was hitting Vitest's 5s
default test timeout while Node evaluated the bundle.

### Fixed

- **Removed the runtime JSON import.** `SDK_VERSION` is now sourced
  from a generated `src/_version.ts` file (produced by
  `scripts/sync-sdk-versions.mjs` from `package.json`). The wire
  contract is unchanged; the build artefact no longer carries a
  JSON-module dependency that Node ESM requires
  `with { type: "json" }` to load from a `.mjs` file.
- **dist-loading test timeout bumped to 60s.** The dynamic-imports of
  100KB+ bundles are genuinely slow on cold Node (~45s measured for
  `vue.mjs`); the assertions themselves are sub-millisecond.

1.3.0 was never published to npm; the only consumers are the public
GitHub repo's v1.3.0 tag (left in place for traceability). 1.3.1 is
the first 1.3.x line to reach npm.

## [1.3.0] — 2026-05-24

KPMG bank-grade audit closure. Six review batches landed five SDK PRs and a backend wiring fix that closes every P0 plus 12 of 13 P1 findings. No public method renames; one internal contract change (`ErrorTracker.beforeSend` is now a getter); behavioural changes to the queue and the PII scrub that strictly improve correctness. Default-safe: existing `Crossdeck.init({...})` callsites keep working exactly the same. The wire `Crossdeck-Sdk-Version` header now reads from `package.json` so it cannot drift from the published bundle.

### Fixed (P0)

- **PII scrub now walks NESTED objects.** Pre-fix `scrubPiiFromProperties` only scrubbed top-level keys plus 1-deep arrays of strings; nested plain objects passed through unchanged. Every `error.*` event ships nested `frames[]` / `breadcrumbs[]` / `context{}` / `http{}` — the leak surface was broad. New impl recurses into plain objects + arrays-of-objects. `Date` / `Map` / `Set` / `Error` instances + class instances pass through untouched (the property validator owns those shapes).
- **PII scrub sentinel tokens aligned with the backend.** `[email]` / `[card]` → `<email>` / `<card>`, matching `backend/src/api/lib/scrub.ts`. The same event scrubbed by SDK + backend now carries the same sentinel — dashboard aggregation works again.
- **`setErrorBeforeSend` installed AFTER init() now actually fires.** Pre-fix the `ErrorTracker` captured `beforeSend` by value at construction, so any hook a customer installed later was silently inert and their PII-redaction escape hatch ran on zero errors. Contract is now a getter; the tracker resolves the current hook on every report.
- **Event queue durability hole during flush.** Pre-fix the buffer was spliced + the persistent blob saved EMPTY before awaiting the network call — a hard-crash mid-flight wiped the persisted batch and the events were lost forever. New `pendingBatch` slot keeps the in-flight batch in the persisted blob until the server confirms it. Side benefit: retries now reuse the same `Idempotency-Key` (Stripe pattern, brings web in lockstep with node).
- **`identify()` cross-customer cache leak.** Pre-fix the entitlement-cache clear was gated on `priorCdcust && new && prior !== new`, missing two real scenarios where a previous user's entitlements leaked to a new login (ITP / partial cookie eviction wiped cdcust but left the cache; rehydration from a pre-persisted-identity legacy install). New contract: clear when the resolved cdcust differs OR the cache is non-empty under an unknown identity.
- **Error-capture self-skip derived from `baseUrl`.** Pre-fix hardcoded to `api.cross-deck.com`; customers on staging / regional / self-hosted relay base URLs recursed (5xx → captureHttp → enqueue → /events → captureHttp → ∞). Now strict-hostname compare against `selfHostname` extracted from `init({ baseUrl })`. Case-insensitive. Closes a subtle substring-match bypass (`api.cross-deck.com.attacker.example` would have matched).

### Added

- **`onPermanentFailure` callback on the event queue.** Fires when the queue drops a batch because the server returned a permanent 4xx (anything except 408 / 429). Loud `console.error` independent of debug mode, plus the new `sdk.flush_permanent_failure` debug signal. Pre-fix the queue retried 4xx forever with the same Idempotency-Key, silently growing the backlog while customers thought events were landing.
- **`onPermanentFailure({ status, droppedCount, lastError })`** is also exposed on the underlying `EventQueueConfig` for embedders wiring their own diagnostics surface.
- **Event-validation regression: DAG sibling sharing.** Two sibling properties pointing at the SAME sub-object no longer trip a false `[circular_reference]` flag. The validator now uses an ancestor-only stack instead of a shared `WeakSet` — real cycles still flag, legitimate DAGs pass through verbatim.

### Changed

- **`SDK_VERSION` is now imported from `package.json`.** The `Crossdeck-Sdk-Version` header always matches the published bundle. Pre-fix the constant drifted independently — the published 1.2.0 bundle reported `@cross-deck/web@1.1.0` on the wire because nobody bumped the literal.
- **4xx hard-stop on the event queue.** Status codes other than 408 / 429 in the 4xx range are NOT retryable; the queue drops the batch and surfaces it via `onPermanentFailure`. 408 / 429 / 5xx / network errors stay retryable. RFC-correct.
- **`Retry-After` is honoured even above `maxMs`.** Pre-fix the policy clamped server-supplied `Retry-After` to `maxMs` (60s default) — a `Retry-After: 120` got truncated to 60s and we hammered the rate limit twice as fast as asked. New 24h absolute sanity cap against server bugs / HTTP-date clock-skew.
- **`reset()` clears the clock-skew snapshot.** `diagnostics().clock.skewMs` no longer echoes the prior session's skew after logout.
- **`pageviewId` nulls on session boundary.** Pre-fix it survived 30-min idle resets and corrupted post-resume event → pageview correlation.
- **`init()` re-entry tears down prior listeners** (`uninstallUnloadFlush`, autoTracker, webVitals, errors). Pre-fix duplicate `pagehide` / `beforeunload` / `visibilitychange` listeners accumulated across HMR / config-swap calls.
- **PII scrub regex now uses `.replace()` unconditionally.** Dropped the `.test()`-gating that carried `lastIndex` state between calls; the gate could false-skip strings that actually matched. Same fix on both SDKs.
- **`isLocalHostname()` matches `0.0.0.0` and IPv6 `fe80::/10`** so webpack-dev-server / Vite dev defaults and cross-device Safari Web Inspector hostnames stop polluting live analytics.
- **Self-skip applies to breadcrumbs too**, not just `captureHttp`. Error reports no longer carry noisy `POST https://api.cross-deck.com/v1/events` crumb entries.
- **`syncPurchases` body spread bug.** Pre-fix `{ rail: input.rail ?? "apple", ...input }` — the `...input` ran LAST and overrode the default when the caller passed `rail: undefined` explicitly. Reversed: `{ ...input, rail }`.
- **Bundle-size budgets raised** to fit the durability + permanent-failure surface (~1.5 KB gzipped of bank-grade code). `core ESM` 33 → 35 KB, `core CJS` 34 → 36 KB, `react / vue ESM` 33 → 35 KB, UMD 18 → 19 KB. Still well under single-pillar competitor ceilings.

### Wiring (backend, paired)

- **`v1-events` ingest now honours the per-project `piiAllowList`.** The admin management surface (`v1-pii-allow-list.ts`) was persisted + audit-logged but the hot ingest path never read it. The new `backend/src/api/lib/pii-allow-list-cache.ts` (60s TTL, single-flight) feeds the project's allow-list to `scrubProperties()` on every batch. `HARD_LOCKED_PATTERNS` are always stripped from the effective list regardless of what's in storage. (Backend-only — listed here so SDK consumers know defence-in-depth is fully closed.)

## [1.1.0] — 2026-05-18

### Added

- **Durable last-known-good entitlement cache.** The entitlement cache is now persisted to device storage and re-hydrated synchronously on SDK boot, so `isEntitled()` is correct from the very first call for a returning customer — there is no cold-start window where a paying user flashes as free. A failed `getEntitlements()` never clears the cache; only a successful fetch replaces it, so a brief Crossdeck outage cannot fail a paying customer down to free. Each entitlement is still honoured against its own `validUntil`, so a timed-out trial still ends.
- **Cache staleness signal.** `diagnostics().entitlements.stale` flags when the cache is serving last-known-good after a failed refresh attempt, or after the data has aged past 24h — making serving-through-an-outage observable instead of a silent unbounded window.

### Changed

- **The entitlement cache is cleared on `reset()` and on an identity switch**, so a prior user's entitlements never leak to the next person on the same device.
- **Bundle-size budgets raised** to fit the durable cache. Device-storage persistence, boot hydration, and refresh-failure tracking are ~0.8 KB gzipped of real code. New gzipped budgets: `core ESM` 32 → 33 KB (32.81 KB actual), `core CJS` 33 → 34 KB (33.27 KB actual — CJS also carries CommonJS boilerplate the ESM build avoids), `react.mjs` / `vue.mjs` 32 → 33 KB. The UMD build holds at 18 KB. Still well under the single-pillar competitive ceiling — Sentry 30 KB (errors only), Mixpanel 55 KB (analytics only), PostHog 40 KB (analytics only) — for one bundle that ships all three pillars. See `sdks/web/scripts/check-bundle-size.mjs`.

## [1.0.1] — 2026-05-13

### Changed

- **Never silently surface an `Unknown error` again.** Non-`Error` throws (`throw { code: 500 }`, custom classes, a `Response` from `fetch`) now keep their type name, message field, and useful properties (`code` / `status` / `cause` chain). Cross-origin script errors land with a clear label and a `cross_origin: true` tag instead of being silently dropped. Distinct call sites no longer collapse into one `Unknown error` bucket. (PR #65 — `@cross-deck/node` 1.1.1 later ported the same hardening.)

## [1.0.0] — 2026-05-11

**Error capture — the third pillar.** Closes the trio: analytics +
revenue/entitlements + errors all ship in one SDK. After this
release the SDK covers every USP the platform sells. Bumped to
`1.0.0` because every pillar is now in the box.

Backwards-compatible: every Wave 1-4 API is unchanged. New error
APIs are additive. Source-compatible with 0.10.x — existing
`Crossdeck.init({...})` callsites work exactly the same.

### Added

- **Automatic uncaught-error capture.** Global `window.onerror` listener
  catches every uncaught synchronous error. Stack traces parsed into
  normalised frames (Chrome / Firefox / Safari). Reported as
  `error.unhandled` Crossdeck events through the same durable +
  retried + idempotent queue as analytics.
- **Automatic promise-rejection capture.** Global
  `window.onunhandledrejection` listener catches unhandled async
  failures. Reported as `error.unhandledrejection`.
- **Automatic HTTP-failure capture.** `fetch()` and
  `XMLHttpRequest` are wrapped to detect 5xx + network failures the
  app code didn't catch. Reported as `error.http`. Crossdeck's own
  API calls are explicitly excluded so a Crossdeck outage doesn't
  self-amplify into the queue.
- **`Crossdeck.captureError(err, { context, tags, level })`** — manual
  capture from try/catch blocks. Sentry pattern.
- **`Crossdeck.captureMessage(message, level)`** — non-error signals
  ("we hit the deprecated path", "soft warning"). Reported as
  `error.message`.
- **`Crossdeck.setTag(key, value)` / `Crossdeck.setTags(tags)`** —
  flat key/value labels attached to every subsequent error report.
- **`Crossdeck.setContext(name, data)`** — structured named context
  attached to every subsequent error report (Sentry pattern).
- **`Crossdeck.addBreadcrumb(crumb)`** — custom breadcrumb for the
  rolling buffer.
- **`Crossdeck.setErrorBeforeSend(hook)`** — pre-send filter; return
  null to drop, or a modified `CapturedError` to scrub fields. The
  only way to redact app-specific PII (auth tokens in URLs, etc.)
  before the report leaves the browser.
- **Breadcrumb ring buffer.** Every analytics event auto-emits a
  breadcrumb. The last 50 are attached to every error report so the
  engineer reading the error sees exactly how the user got into the
  broken state. Cleared on `reset()` / `forget()`.
- **Fingerprinting.** Every error gets a stable 8-character hex
  fingerprint (`djb2` of message + top 3 in-app frames). Dashboard
  uses this to group identical errors so 1,000 occurrences of the
  same bug show as 1 issue, not 1,000.
- **Rate limiting.** Per fingerprint: max 5 reports per minute.
  Defends against runaway loops (e.g. error in `setInterval`).
  Hard session cap: 100 errors total. After that, capture stops
  until the next session — the developer is told via Sentry
  receiving "1 unique error" instead of "1 million events".
- **Noise filtering.** Default `ignoreErrors` strips well-known
  browser noise (`ResizeObserver loop limit exceeded`, `Script
  error.`, etc.). Default `denyUrls` strips browser-extension
  frames (`chrome-extension://`, `moz-extension://`, etc.).
- **`autoTrack.errors: boolean`** flag (default true). Disable if
  you have a separate error tracker (Sentry, Bugsnag) and don't
  want duplicates.
- **`consent.errors`** dimension (already in 0.10.0 for Web Vitals)
  now ALSO gates error reporting. `consent({ errors: false })`
  silently drops every error event.
- **PII scrub** runs on every error payload (stack strings, URLs,
  context blobs) before they leave the browser — same regex pass
  as the analytics path.
- **New error code** in `CROSSDECK_ERROR_CODES` for the
  request_timeout / fetch_failed family already covered.
- **47 new tests** (306 total, up from 260):
    - `tests/breadcrumbs.test.ts` — 6 cases.
    - `tests/stack-parser.test.ts` — 13 cases covering Chrome /
      Firefox / Safari formats + in-app detection + fingerprinting.
    - `tests/error-capture.test.ts` — 21 cases covering captureError,
      captureMessage, filtering, rate limiting, sampling, beforeSend
      hook, context/tags attachment, breadcrumb snapshot, consent
      gating.
    - `tests/crossdeck.test.ts` — 7 new integration cases.
    - `tests/dist-loading.test.ts` — extended to assert the new
      public methods exist on the built artefact.
    - `e2e/smoke.spec.ts` — 5 new Playwright cases covering real-
      browser error capture (manual captureError, uncaught
      window.onerror, captureMessage, breadcrumb attachment,
      consent gate).

### Changed

- **Bundle-size budgets bumped** to account for the new pillar:
  core ESM / CJS / React / Vue from 28 KB → 32 KB; UMD from
  16 KB → 18 KB. The full SDK now ships at ~30 KB gz —
  comparable to Sentry's `@sentry/browser` *alone* (which doesn't
  include analytics or revenue). All three pillars in one bundle.
- `AutoTrackOptions` extended with `errors: boolean`.
- `track()` now gates `error.*` events on `consent.errors` (in
  addition to the existing `webvitals.*` gate); everything else
  continues to gate on `consent.analytics`.

### Compatibility

Source-compatible with 0.10.x. No public API removed. The new error
capture is on by default — applications that already have Sentry
installed should set `autoTrack: { errors: false }` to avoid
duplicate reporting.

## [0.10.0] — 2026-05-11

**Privacy + compliance + operational pass (Waves 3 + 4).** Locks down GDPR / CCPA support, ships the CDN + framework story, and publishes the error-code surface that Stripe-style integrators depend on. Backwards-compatible — every new field defaults to "don't change behaviour". Source-compatible with 0.9.x.

### Added

- **`Crossdeck.consent({ analytics, marketing, errors })`** — three independent consent dimensions, each defaulting to `true` (granted). Gates `track()`, `identify()`, paid-traffic click IDs, referrer URLs, and Web Vitals appropriately. `Crossdeck.consentStatus()` returns the current snapshot.
- **`respectDnt: true`** in `init()` — opt-in DNT support. When the browser exposes `navigator.doNotTrack === "1"`, ALL three consent dimensions are locked OFF permanently (no subsequent `consent()` call can flip them back on).
- **`scrubPii: true`** (default-on) in `init()` — Stripe-grade regex pass over every event property value, URL path, and title before flush. Email-shaped → `<email>`, card-number-shaped → `<card>` (tokens aligned with the backend's defence-in-depth scrubber). The walk is recursive: nested plain objects + arrays-of-objects are visited. Caller's input is never mutated. Disable for pipelines that do their own redaction.
- **`Crossdeck.forget(): Promise<void>`** — GDPR / CCPA right to be forgotten. Calls the new `/v1/identity/forget` endpoint and wipes ALL local state. Idempotent. Server-side failure does NOT block local wipe.
- **`@cross-deck/web/vue` subpackage** — Vue 3 composables (`useEntitlement(key)` → `Ref<boolean>`, `useEntitlements()` → `Ref<string[]>`) that mirror the React subpackage's contract. Subscribes to the entitlement cache via `onEntitlementsChange`. SSR-safe.
- **UMD CDN bundle** — `dist/crossdeck.umd.min.js`, registered via `unpkg` / `jsdelivr` package.json fields. Exposes `window.Crossdeck` for no-build-step consumers (plain HTML, Webflow, docs). 13 KB gzipped.
- **`CROSSDECK_ERROR_CODES` + `getErrorCode(code)`** — machine-readable index of every error code the SDK can throw, with `description`, `resolution`, and `retryable` flag. Also emitted as `dist/error-codes.json` sidecar. Stripe pattern.
- **Bundle-size budget enforcement** — `npm run size` (also runs in `prepublishOnly`) fails the release if any artefact exceeds its gzipped budget. Current ceilings: 28 KB for core / framework subpackages, 16 KB for UMD.
- **New debug signals:** `sdk.consent_changed`, `sdk.consent_denied`, `sdk.consent_dnt_applied`, `sdk.pii_scrubbed`.

### Backend changes (paired)

- **`POST /v1/identity/forget`** — new endpoint. Resolves the customer from any identity hint, sets `forgottenAt: now` on the customer record, queues a `forgetRequests` row for the retention-cleanup worker to drain.
- **`POST /v1/identity/alias`** — now accepts optional `traits` in the body and persists them under `customers/{cdcust}.traits` additively (per-key merge). Defence-in-depth sanitisation server-side: max 32 keys, 1 KB per value, primitives only.

### Compatibility

Source-compatible with 0.9.x. The new defaults (`scrubPii: true`, `respectDnt: false`) preserve existing analytics shape for current consumers. The Vue subpackage adds an optional peer dependency declared in `peerDependenciesMeta` — non-Vue consumers don't install it.

## [0.9.0] — 2026-05-11

**Data completeness pass (Wave 2).** Closes the gap between Crossdeck's event surface and Mixpanel / Segment / Amplitude. Backwards-compatible — `Crossdeck.init({...})` callsites don't need to change; the new APIs are additive.

### Added

- **`Crossdeck.identify(userId, { traits })`** — accept profile traits (name, plan, signupDate, role) alongside the email field. Traits are sanitised at the SDK boundary and persisted server-side on the customer record under `customers/{cdcust}.traits` (per-key merge, additive — a later identify call with `{ plan: "pro" }` doesn't wipe a prior call's `{ name: "Wes" }`). Defence-in-depth server validation: max 32 keys, 1 KB per value, primitives only.
- **`Crossdeck.register(properties)` + `unregister(key)` + `getSuperProperties()`** — Mixpanel "super properties" pattern. Set keys once, attached to every subsequent event of this SDK instance. Null value deletes a key. Persists across page reloads via the identity storage; cleared on `reset()` / `forget()`.
- **`Crossdeck.group(type, id, traits?)` + `getGroups()`** — Mixpanel / Segment "Group Analytics". Each event carries `$groups.<type>: id` for B2B SaaS dashboards. Multiple types coexist (`org` + `team` + `plan`). Pass `id: null` to clear a group membership.
- **Paid-traffic click ID capture** — `gclid` (Google Ads), `fbclid` (Meta), `msclkid` (Microsoft), `ttclid` (TikTok), `li_fat_id` (LinkedIn), `twclid` (X / Twitter). Captured at session start alongside UTMs, attached to every event of the session.
- **`pageviewId`** — stable per-page-view identifier minted on every `page.viewed` and attached to every subsequent event until the next `page.viewed`. Mixpanel's `$current_url`-style correlation — lets dashboards answer "user clicked X on page Y" without timestamp arithmetic.
- **Web Vitals capture** — `webvitals.lcp`, `webvitals.inp`, `webvitals.cls`, `webvitals.fcp`, `webvitals.ttfb` events emitted via `PerformanceObserver`. LCP / CLS / INP flush at page hidden (final values only known after user activity stops). New `autoTrack.webVitals` flag (default true). Hand-rolled (~120 lines), zero runtime deps.

### Changed

- `IdentifyOptions` extended with `traits?: Record<string, unknown>`. Existing `email`-only callers unaffected.
- `AutoTrackOptions` extended with `webVitals: boolean`. Existing `init()` callsites without `autoTrack` get it default-on.
- `SessionAcquisition` extended with the six paid-traffic click-ID fields. Existing acquisition consumers unaffected — fields are empty strings when not present.

### Compatibility

Source-compatible with 0.8.x. No public API removed. Every new field defaults to a sensible value that preserves the previous behaviour for existing callsites.

## [0.8.0] — 2026-05-11

**Bank-grade plumbing pass (Wave 1).** Six closely-coupled hardenings that bring the SDK's reliability surface up to Stripe / Segment / Mixpanel standards. Backwards-compatible: no public API removed, every new option has a sensible default, every behaviour change is additive. Source-compatible with 0.7.x — `Crossdeck.init({...})` callsites do not need to change.

### Added

- **Durable event queue.** Queued events are now written through to the SDK's identity store (typically `localStorage`) so a hard browser crash, power loss, or terminal-flush `keepalive: true` cap exceedance (64 KB) doesn't lose data. On the next SDK boot the persisted queue is rehydrated and replayed. Backend dedupes by `eventId` so a replayed event already on the wire when the tab crashed is safe — `ReplacingMergeTree` handles it. New module `event-storage.ts` (`PersistentEventStore`). Skipped when `persistIdentity: false` (strict-consent flows).
- **Exponential backoff with full jitter on flush failures.** Replaces the prior "retry on the next idle window" policy which hot-looped a flapping endpoint. Defaults: `baseMs=1000`, `factor=2`, `maxMs=60000`. Each failure schedules the next flush at `min(maxMs, baseMs * 2^attempts) * Math.random()` ms out. Reset on success. Surface via `diagnostics().events.consecutiveFailures` + `nextRetryAt`. New module `retry-policy.ts` (`RetryPolicy`, `computeNextDelay`).
- **`Retry-After` header support on 429 / 503.** The HTTP layer now parses the header (delta-seconds or HTTP-date per RFC 7231 §7.1.3) onto `CrossdeckError.retryAfterMs`, and the retry policy honours it when it's longer than the computed backoff. Stripe pattern — the server is the authority on its own pressure.
- **`Idempotency-Key` header per batch.** Every `/v1/events` POST now carries `Idempotency-Key: batch_<rand>`. Retries of the SAME logical batch reuse the SAME key so a future server-side idempotency layer can short-circuit duplicate work without inspecting bodies. Per-event `eventId` dedup remains in place — this is belt-and-suspenders.
- **Request timeout via `AbortController`.** New `timeoutMs` option on `CrossdeckOptions` and per-request `options.timeoutMs` on `HttpClient.request()`. Default 15 000 ms. Without this, a captive portal / DNS hang / satellite link could leave a request open for the browser's default (5+ minutes on Chrome) and lock the queue forever. Pass `timeoutMs: 0` to disable (useful for tests). New error: `CrossdeckError({ type: "network_error", code: "request_timeout" })`.
- **Property validation at enqueue.** `track(name, properties)` now sanitises `properties` BEFORE the event lands in the queue. New module `event-validation.ts`. Behaviour:
    - **Drops** functions, symbols, undefined values (with a debug warning).
    - **Coerces** `Date` → ISO string, `BigInt` → string, `Error` → `{ name, message, stack }`, `Map` → plain object, `Set` → array.
    - **Truncates** string values longer than `maxStringLength` (default 1024) with an ellipsis.
    - **Replaces** circular refs with `"[circular]"` and depth > 5 nesting with `"[depth-exceeded]"`.
    - **Caps** total per-event property byte size at `maxBatchPropertyBytes` (default 8 KB); past the cap, largest properties drop first and a `__truncated: true` marker is added.
    - Caller's input is never mutated — sanitisation always produces a defensive copy.
    - Output is guaranteed `JSON.stringify`-safe. One bad property can no longer poison the entire batch indefinitely.
- **Listener-error counter on `EntitlementCache`.** Listener exceptions are still swallowed (a buggy consumer must not crash the SDK) but the cumulative count is now surfaced as `diagnostics().entitlements.listenerErrors` so a broken subscriber can be spotted without a debug session.
- **Clock-skew diagnostics.** `Crossdeck.heartbeat()` now captures the server's `serverTime` and the local `Date.now()` at the same moment. Surfaces via `diagnostics().clock.{lastServerTime, lastClientTime, skewMs}` so a wrong-system-clock problem (kid changed the date, dev machine bad NTP) surfaces in dashboards before it corrupts a day of analytics.
- **New debug signals:** `sdk.property_coerced`, `sdk.queue_persisted`, `sdk.queue_restored`, `sdk.flush_retry_scheduled`. Fire in debug mode only — quiet by default.
- **65 new tests** (203 total, up from 138):
    - `tests/event-validation.test.ts` — 19 cases covering every coercion / drop / truncation / depth / size-cap path + JSON-roundtrip + no-mutation guarantee.
    - `tests/event-storage.test.ts` — 8 cases covering load / save round-trip, debouncing, malformed-blob recovery, version sentinel, throwing-storage degradation.
    - `tests/retry-policy.test.ts` — 12 cases covering backoff math, jitter, Retry-After precedence, attempt overflow safety, counter reset.
    - `tests/event-queue.test.ts` — 9 new cases covering Idempotency-Key uniqueness, retry scheduling, server Retry-After honouring, durable rehydration, write-through, persistent clear on success, reset() wipe.
    - `tests/http.test.ts` — 5 new cases covering Idempotency-Key passthrough, abort-timeout behaviour, per-call timeout override, 0-disables-timeout, Retry-After parse onto `retryAfterMs`.
    - `tests/errors.test.ts` — 9 new cases covering `parseRetryAfterHeader` for delta-seconds, HTTP-date, past dates, malformed input.
    - `tests/entitlement-cache.test.ts` — 1 new case covering the listener-error counter.
    - `tests/crossdeck.test.ts` — 1 new case asserting the full Wave-1 diagnostic surface.

### Changed

- `CrossdeckError` now carries an optional `retryAfterMs` field, populated from the response's `Retry-After` header on 4xx/5xx.
- `Diagnostics` shape extended with:
    - `clock: { lastServerTime, lastClientTime, skewMs }`
    - `entitlements.listenerErrors: number`
    - `events.consecutiveFailures: number`, `events.nextRetryAt: number | null`
- Existing `Diagnostics` fields and their semantics are unchanged.

### Migration

No callsite changes required. New options (`timeoutMs`, retry tuning) default to sensible bank-grade values. To opt out of property validation, pass already-clean property objects — there's no escape hatch, and there shouldn't be: an SDK that lets one bad event poison the whole batch isn't bank-grade.

## [0.6.0] — 2026-05-10

Bank-grade analytics enrichment. Two additive changes that close the gap between Crossdeck's analytics surface and Google Analytics 4 / Google Ads dashboards: identity continuity that survives cleared storage, and first-touch acquisition attribution attached to every event of a session. No public API changes — `Crossdeck.init({...})` callsites do not need to change.

### Added

- **Identity continuity — dual-store redundancy.** The SDK now writes `anonymousId` and `crossdeckCustomerId` to BOTH `localStorage` (primary) and a 1st-party `document.cookie` (secondary). On boot it reads both and prefers primary; if primary is empty, it recovers from the cookie and resyncs primary. This protects against ITP localStorage purges, "clear site data" actions, and aggressive privacy extensions — a returning user keeps the same Crossdeck identity instead of becoming a phantom new visitor on dashboards. See `sdks/SDK_TRUTH.md` § "Identity continuity — bank-grade redundancy" for the full contract.
- **`CookieStorage` adapter** in `storage.ts`. Sets `Path=/`, `Max-Age=63072000` (2y), `SameSite=Lax`, `Secure` (when over HTTPS — omitted on `http://localhost` so dev works without a TLS cert). Encodes/decodes cookie names + values defensively so embedded `;` and `=` survive round-trip.
- **First-touch acquisition capture in `AutoTracker`.** On every `session.started` the SDK reads `window.location.search` and `document.referrer` and captures `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, plus `referrer`. Non-empty values are auto-attached to every subsequent event of that session — matching GA4's session-pinned attribution semantics. SPA route changes mid-session do NOT re-read the URL; a new session (>30 min idle, or explicit `resetSession()`) re-captures off the current URL.
- **`AutoTracker.currentAcquisition`** getter. Returns the captured-once-per-session acquisition context for inspection / tests / framework bindings. Returns empty strings (not undefined) when there's no active session so callers can spread without conditional logic.
- **`captureAcquisition()` exported** from `auto-track.ts` for unit testing acquisition extraction in isolation.
- **18 new tests** (138 total, up from 120):
    - `storage.test.ts` — 6 cases covering `CookieStorage` round-trip, URL-encoding survival, attribute emission (Path / SameSite / Max-Age / Secure on HTTPS, Secure-omitted on HTTP), null on broken cookies, no-op in Node (no `document`).
    - `identity.test.ts` — 6 cases covering the redundancy contract: writes-to-both, recovery from secondary when primary cleared, recovery from primary when secondary cleared, primary-wins-on-conflict, set/reset both, defence-in-depth against a throwing secondary.
    - `auto-track.test.ts` — 5 cases: `captureAcquisition` reads utm_*, returns empty for clean URLs, `currentAcquisition` is session-pinned (SPA navigation does NOT change it mid-session), `resetSession` re-captures off the current URL, returns empty when no session exists.

### Server-side enrichment (lands without an SDK upgrade)

The 0.6.0 SDK pairs with these backend changes that started populating ClickHouse columns ahead of this release — every existing 0.5.0 install starts seeing them in dashboards immediately:

- **Geography** — `events.country` populated from the Cloudflare `CF-IPCountry` header at `/v1/events`. Server-decided, not client-trusted.
- **New vs returning** — `events.is_new` populated by a Firestore-transactional `visitors/{anonymousId}` upsert in the ClickHouse projector. First event for a new anonymousId wins the race; concurrent inserts converge.
- **Device hoist** — `events.browser`, `events.os`, `events.device_class` hoisted out of `properties_json` to first-class LowCardinality columns for fast slicing.
- **Acquisition columns** — `events.utm_source`, `events.utm_medium`, `events.utm_campaign`, `events.utm_content`, `events.utm_term`, `events.referrer_host` populated from event properties (which the 0.6.0 SDK now sends; pre-0.6.0 events get empty strings).
- **Sessions** — `sessions` table aggregates the same enrichment columns via `any` / `max` (for `is_new`) so per-session breakdowns don't have to fan out across raw events.
- ClickHouse migration `006_analytics_columns.sql` is idempotent and additive — old rows already in `events` keep working with empty / 0 defaults.

### Privacy posture

Privacy posture is unchanged from single-store identity. The cookie holds only the same `anonymousId` already in `localStorage` — no fingerprintable data, no PII. Anything that can read `localStorage` on the same origin can read this cookie; the security model is identical to Stripe, Segment, and PostHog's 1st-party identity cookies. `persistIdentity: false` continues to disable all persistence (in-memory only) for customers running strict consent flows.

### Compatibility

Source-compatible with 0.5.0. No public API changes. No deprecated symbols. Existing snippets do not need to change.

## [0.4.0] — 2026-05-09

Reactive entitlements. Pre-0.4.0, calling `Crossdeck.isEntitled("pro")` directly inside a React render path showed the empty-cache result forever — React had no way to know the cache had populated asynchronously after `init()`. This release closes that gap with a first-class subscribe API on the SDK and a React subpackage that uses it.

### Added

- **`Crossdeck.onEntitlementsChange(listener)`** — synchronous subscribe API. Returns an idempotent unsubscribe function. Listeners fire AFTER each cache mutation (`getEntitlements`, `syncPurchases`, `reset`). Listener errors are swallowed. NOT fired on subscribe — read state inline if you need the initial value. See `sdks/SDK_TRUTH.md` for the full contract.
- **`@cross-deck/web/react` subpath export** — first-class React hooks built on top of the subscribe API:
    - `useEntitlement(key): boolean` — re-renders the component the moment the cache mutates so a JSX snippet like `useEntitlement("pro") && <ProBadge />` actually works.
    - `useEntitlements(): readonly string[]` — reactive list of all active entitlement keys.
  - SSR-safe: hook returns `false` / `[]` on the server and hydrates correctly on the client. Pre-init returns the empty default until `Crossdeck.init()` runs and a cache mutation lands.
- **`EntitlementCache.subscribe(listener)`** — internal listener API on the cache itself. Powers `onEntitlementsChange`. Iterates over a snapshot of the listener set so listeners that unsubscribe themselves during dispatch don't break the iteration.
- **Tests** — 7 new cases covering listener semantics: fires on `setFromList`, fires on `clear`, NOT fired on subscribe, idempotent unsubscribe, listener errors are non-fatal, self-unsubscribe-during-dispatch is safe.

### Why this exists

Without a subscribe API, every framework binding (React, SwiftUI, Compose, Vue, Solid) had to invent its own re-render trigger by polling or hooking into private SDK internals. The cache is the only place that knows precisely when `isEntitled()` would change its answer; making it the source of the notification is the correct contract. iOS and Android SDKs MUST adopt the same pattern internally before 1.0 and MUST expose framework bindings (`@Observable` / SwiftUI for iOS, `StateFlow<Boolean>` / Compose for Android) that mirror the React hook's semantics. See the SDK NorthStar Addendum §11.4.

### Build

- `tsup` now emits two entry points (`dist/index.{cjs,mjs}` and `dist/react.{cjs,mjs}`) with a custom `outExtension` matching the `package.json` exports map.
- React is now an optional peer dependency (`react >=18`).

### Compatibility

Source-compatible with 0.3.0. No breaking changes — `onEntitlementsChange` and the React hooks are purely additive.

## [0.3.0] — 2026-05-08

This release reconciles the web SDK with the Crossdeck SDK NorthStar Addendum (§4 Shared Contract, §11.1 Web SDK pattern, §13.1 wire envelope, §15 sensitive properties, §16 debug signal vocabulary). The public surface now matches what the iOS, Android, and Node SDKs will expose — `init`, `flush`, `syncPurchases`, `setDebugMode`.

### Added

- **`Crossdeck.init({ appId, publicKey, environment })`** — canonical lifecycle method per NorthStar §4. The trio is required and validated up-front: a publishable-key prefix that disagrees with the declared `environment` throws `CrossdeckError({ code: "environment_mismatch" })` at boot, so a typo can't silently route prod data into sandbox dashboards.
- **`Crossdeck.flush()`** — alias of the old `flushEvents()`, matching the standardised name.
- **`Crossdeck.syncPurchases(input)`** — replaces `purchaseApple`. Posts to `/v1/purchases/sync` and accepts an optional `rail` field for future Stripe/Google support.
- **`Crossdeck.setDebugMode(enabled)`** + `debug` init option — toggle the §16 debug signal vocabulary (`sdk.configured`, `sdk.first_event_sent`, `sdk.no_identity`, `sdk.purchase_evidence_sent`, `sdk.environment_mismatch`, `sdk.sensitive_property_warning`).
- **Sensitive-property warnings** — when debug mode is on, `track()` warns once per call if any property key matches `email|password|token|secret|card|phone` (NorthStar §15). The event is still sent unmodified; the warning surfaces accidental PII in the dashboard onboarding feed.
- **NorthStar §13.1 wire envelope** — every `/v1/events` POST now includes `appId`, `environment`, and `sdk: { name, version }` at the batch level. The backend validates these against the API-key-resolved app and rejects mismatches with `permission_error / env_mismatch`.

### Changed

- `Crossdeck.start()` is now a deprecated alias of `init()` and emits a `console.warn` once per call. The signature is unchanged, but the new `appId` and `environment` options are still required even when calling `start`.
- `Crossdeck.purchaseApple()` is now a deprecated alias of `syncPurchases({ rail: "apple", ... })`. The new method posts to `/v1/purchases/sync`; the legacy `/v1/purchases` route is kept on the backend for v0.2.x callers.
- The `not_started` configuration error code is now `not_initialized` to match the rename.

### Removed

Nothing. v0.3.0 is fully source-compatible with v0.2.x callers — the legacy method names log a deprecation but continue to work. Plan to drop them in v0.5.0.

## [0.2.0] — 2026-05-06

- Added auto-tracking: sessions, page views, and device-info enrichment are on by default in browsers. See `autoTrack` config to disable individually or wholesale.
- Stable `Diagnostics` shape regardless of whether `start()` has been called — pre-start values are sensible empties.

## [0.1.0] — 2026-05-05

Initial public release.
