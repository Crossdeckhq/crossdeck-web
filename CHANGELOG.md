# Changelog

All notable changes to `@cross-deck/web` will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
