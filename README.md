# @cross-deck/web

The Crossdeck SDK for browsers and Node.js. One package, one mental model, every Crossdeck client API in five lines of setup.

```bash
npm install @cross-deck/web
```

## Quick start

```ts
import { Crossdeck } from "@cross-deck/web";

// 1. Boot once at app start. Synchronous and idempotent.
Crossdeck.init({
  appId: "app_web_xxx",         // from the Crossdeck dashboard
  publicKey: "cd_pub_live_…",   // publishable key, safe in client code
  environment: "production",    // "production" or "sandbox"
});

// 2. Telemetry — fire-and-forget, batched in the background.
Crossdeck.track("paywall_viewed", { variant: "v3" });

// 3. Auth + entitlements happen inside an async boot function (or a
//    React useEffect, or any other async context). Top-level await is
//    not portable across all bundlers.
async function bootCrossdeck() {
  // Wire identify() to YOUR auth state — never hardcode a placeholder.
  await Crossdeck.identify(currentUser.id);
  await Crossdeck.getEntitlements();   // warm the local cache

  // 4. Sync access checks (microsecond reads from cache).
  if (Crossdeck.isEntitled("pro")) {
    showProFeatures();
  }
}
```

### React quick start

For React apps, install Crossdeck once at the root and use the
`useEntitlement` hook from `@cross-deck/web/react` so components
re-render when entitlements arrive:

```tsx
"use client"
import { useEffect } from "react";
import { Crossdeck } from "@cross-deck/web";
import { useEntitlement } from "@cross-deck/web/react";

export function CrossdeckProvider({ children }) {
  useEffect(() => {
    Crossdeck.init({
      appId: "app_web_xxx",
      publicKey: "cd_pub_live_…",
      environment: "production",
    });
    Crossdeck.getEntitlements();   // warm the cache (fire-and-forget)
  }, []);
  return children;
}

export function ProBadge() {
  const isPro = useEntitlement("pro");
  return isPro ? <span className="badge">Pro</span> : null;
}
```

`useEntitlement` subscribes to the SDK's reactive cache via
`Crossdeck.onEntitlementsChange()`, so every component using the hook
re-renders the moment entitlements change. SSR-safe: returns `false`
on the server and hydrates correctly on the client.

That's the full happy path.

## What it does

- **Auto-tracking, on by default.** Sessions, page views, and device info (OS, browser, locale, timezone, screen size, app version) ship from boot. No instrumentation needed for the basics. Disable any of them via `autoTrack: { sessions: false }` etc.
- **One identity for every device + user.** Pre-login events get an `anonymousId`. After login, `identify()` links them to your user ID through Crossdeck's identity graph. The SDK persists both so subsequent app launches resume where you left off.
- **Synchronous entitlement reads.** `getEntitlements()` populates a local cache. `isEntitled("pro")` is a Set lookup — no network call, no waiting.
- **Batched telemetry.** `track()` queues events in memory; the SDK flushes every 5 seconds (configurable) or when the buffer hits 20 events. Network failures re-queue the batch — events aren't lost on a flaky connection.
- **Boot heartbeat.** On `init()` the SDK pings `/v1/sdk/heartbeat` so the dashboard's Apps page can show you "last seen" per install. Disable with `autoHeartbeat: false`.
- **Stripe-style errors.** Every async method throws `CrossdeckError` with `type`, `code`, `requestId`, and `status` — same shape as Stripe's SDKs, so generic error handlers transfer.

## Auto-tracked events

| Event | When |
|---|---|
| `session.started` | When a **new** session begins — first visit, or the first page load after >30 min of inactivity. A session resumed across a page navigation does **not** re-fire it. Carries `sessionId`. |
| `session.ended` | On a real session end only: >30 min of inactivity, or an explicit `Crossdeck.stop()`. Carries `sessionId` and `durationMs`. |
| `page.viewed` | On initial load + every SPA navigation (`history.pushState`, `replaceState`, `popstate`). Carries `path`, `url`, `search`, `hash`, `title`, `referrer`. |

Every event — auto-tracked and developer-emitted — is enriched with the device-info payload below.

**Sessions survive page loads (v1.6.0+).** A session is a *visit*, not a page. The SDK persists the session (id, start time, last-activity time, first-touch acquisition) to the same storage as identity, so a full-page navigation on a multi-page site **resumes the same session** rather than starting a new one. The window is a rolling 30-minute inactivity timer bumped by every tracked event (auto or custom); only real 30-min inactivity or `Crossdeck.stop()` ends it. A page unload (`pagehide`/`beforeunload`) is treated as a navigation, not an end. Quick tab switches (Cmd-Tab) likewise don't end the session — matching GA4's session-window convention. Continuity is same-origin; cross-subdomain stitching is on the roadmap. With `persistIdentity: false` (or a `MemoryStorage` adapter) the session is in-memory only and resets per page.

**Per-session acquisition (v0.6.0+):** when a session starts the SDK reads `window.location.search` and `document.referrer` and captures `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, plus `referrer`. Non-empty values are auto-attached to every subsequent event of that session — first-touch attribution stays pinned to the entry URL even after SPA route changes strip the params away, and now stays pinned across full-page navigations within the session too. A new session (>30 min idle) re-reads the URL.

## Auto-attached device info

Every event's `properties` is enriched with whatever the SDK can detect:

```ts
{
  os: "macOS" | "iOS" | "Android" | "Windows" | "Linux",
  osVersion: "14.4",
  browser: "Safari" | "Chrome" | "Firefox" | "Edge" | "Opera",
  browserVersion: "17.5",
  locale: "en-US",
  timezone: "Africa/Johannesburg",
  screenWidth: 2560,
  screenHeight: 1440,
  viewportWidth: 1440,
  viewportHeight: 900,
  devicePixelRatio: 2,
  appVersion: "1.2.3",   // only when you set Crossdeck.init({ appVersion })
}
```

No fingerprinting, no IP collection on the event document, no canvas hashing. Privacy by default. Caller-supplied properties always override auto-detected ones, so you can override `appVersion` per event if you A/B builds.

## API

### `Crossdeck.init(options)`

Boot the client. Idempotent — calling twice with the same options is fine. (`Crossdeck.start()` is kept as a deprecated alias for v0.2.x callers.)

```ts
Crossdeck.init({
  appId: "app_web_xxx",               // required — from the dashboard
  publicKey: "cd_pub_live_…",         // required
  environment: "production",          // required — "production" | "sandbox"
  baseUrl: "https://api.cross-deck.com/v1",  // override for self-host or emulator
  appVersion: "1.2.3",                // attached to every event as properties.appVersion
  autoTrack: true,                    // default — sessions, page views, device info
  // …or granular: autoTrack: { sessions: false } keeps page views + device info
  autoHeartbeat: true,                // default; set false for high-frequency boots
  eventFlushBatchSize: 20,            // default
  eventFlushIntervalMs: 5_000,        // default
  storage: customStorage,             // override the persistence adapter
  debug: false,                       // verbose §16 debug signals when true
});
```

Crossdeck checks the key prefix matches `environment`: `cd_pub_test_…` must declare `"sandbox"`, `cd_pub_live_…` must declare `"production"`. Mismatches throw `CrossdeckError({ code: "environment_mismatch" })` at init time so a typo can't silently route prod telemetry into sandbox dashboards.

The publishable key is safe to ship in client code. Crossdeck enforces origin allowlists (web), bundle-ID binding (mobile), and rate limits at the edge — see [docs/api-keys](https://cross-deck.com/docs/api-keys/) for the full security model.

### `await Crossdeck.identify(userId, options?)`

Link the anonymous device to a developer-supplied user ID. Persists the resolved Crossdeck customer ID for follow-up reads. Returns the `AliasResult`:

```ts
{
  object: "alias_result",
  crossdeckCustomerId: "cdcust_…",
  linked: [
    { type: "developer", id: "user_847" },
    { type: "anonymous", id: "anon_…" },
  ],
  mergePending: false,   // see "Merge candidates" below
  env: "production",
}
```

If `mergePending: true`, both identifiers already pointed at different customers. Crossdeck **never silently merges** — your dashboard's operations queue surfaces the merge for human confirmation.

**Entitlement-cache isolation (v1.4.0).** Every `identify(userId)` switches the local entitlement cache to a per-user storage slot — `localStorage["crossdeck:entitlements:<sha256(userId)>"]` — and unconditionally wipes the in-memory snapshot. A user-switch on a shared device CANNOT cross-read a prior user's cached entitlements, even if the in-memory clear is somehow skipped, because the storage keys are physically separate. `reset()` then wipes every per-user slot on the device (logout-grade).

**Idempotency-Key (v1.4.0).** Every `syncPurchases()` derives a
deterministic `Idempotency-Key` from the request body — same
signed transaction in produces the same key out. The backend
short-circuits repeats with `idempotent_replay: true` in the
response, so a network blip / app crash mid-flight that re-fires
the same purchase doesn't double-process. The key is a UUID-shaped
SHA-256 digest of `crossdeck:purchases/sync:<rail>:<jws|token>`,
so two SDKs reporting the same Apple transaction land on the same
key.

### `await Crossdeck.getEntitlements()`

Fetch the current customer's active entitlements. Returns an array of `PublicEntitlement` and updates the local cache.

```ts
const ents = await Crossdeck.getEntitlements();
// [{ object: "entitlement", key: "pro", isActive: true, validUntil: 1717891200, source: {...}, updatedAt: ... }]
```

### `Crossdeck.isEntitled(key) → boolean`

Synchronous read from the local cache. Returns `false` until you've called `getEntitlements()` once (or `purchaseApple()` resolved). After that, it's a Set lookup — call as often as you want.

### `Crossdeck.track(name, properties?)`

Queue a telemetry event. Returns immediately. Events flush in batches; force a flush with `flush()`:

```ts
Crossdeck.track("checkout_started", { product: "annual_pro" });
// …later, e.g. before page unload:
window.addEventListener("beforeunload", () => {
  void Crossdeck.flush();
});
```

Event names match `[A-Za-z0-9_.\-:]+`, max 128 chars. Properties are JSON-serialisable, max 8 KB per event after JSON encoding.

In `debug: true` mode the SDK warns (one signal per call) when property keys look like PII — `email`, `password`, `token`, `secret`, `card`, `phone`. Crossdeck never strips fields automatically; the warning is so accidental leaks surface during development, not in prod logs.

### `await Crossdeck.syncPurchases(input)`

Forward purchase evidence (Apple StoreKit 2) directly to Crossdeck for verification — closes the purchase-to-entitled latency from seconds to milliseconds (faster than waiting for the App Store webhook). (`purchaseApple()` is kept as a deprecated alias.)

```ts
// Inside an async transaction handler — wrap top-level awaits.
async function forwardTransaction(transaction) {
  await Crossdeck.syncPurchases({
    signedTransactionInfo: transaction.jsonRepresentation, // from StoreKit 2
    signedRenewalInfo: subscription.signedRenewalInfo,     // optional
    appAccountToken: "uuid-…",                             // optional
  });
}
```

Stripe and Google purchases are verified via webhooks (Stripe Connect platform endpoint, Google Play RTDN) — there's no SDK-side push for those.

### `await Crossdeck.heartbeat()`

Manually send a heartbeat. Called automatically by `init()` unless `autoHeartbeat: false`. Returns the readiness summary the dashboard uses to display SDK installation status.

### `Crossdeck.reset()`

Wipe persisted identity + EVERY per-user entitlement cache slot on this device + queued events. Call on logout. The next session generates a fresh `anonymousId` and starts a clean identity-graph entry. The per-user scope of the cache wipe (introduced v1.4.0) means a shared-device logout cannot leave a separate user's entitlements readable from `localStorage`.

### `Crossdeck.flush()`

Force-flush the in-memory event queue. Useful before page unload or when shutting down a script. (`flushEvents()` is kept as a deprecated alias.)

### `Crossdeck.setDebugMode(enabled)`

Toggle the verbose debug-signal vocabulary at runtime (NorthStar §16). When enabled, the SDK emits a fixed set of `console.info` lines tagged `[crossdeck:sdk.<signal>]` for `sdk.configured`, `sdk.first_event_sent`, `sdk.no_identity`, `sdk.purchase_evidence_sent`, `sdk.environment_mismatch`, and `sdk.sensitive_property_warning`.

### `Crossdeck.diagnostics()`

Diagnostic snapshot — useful for development consoles and bug reports:

```ts
{
  started: true,
  anonymousId: "anon_…",
  crossdeckCustomerId: "cdcust_…" | null,
  developerUserId: "user_…" | null,
  sdkVersion: "0.1.0",
  baseUrl: "https://api.cross-deck.com/v1",
  entitlements: { count: 2, lastUpdated: 1717891200000 },
  events: { buffered: 0, dropped: 0, inFlight: 0, lastFlushAt: 1717891200000, lastError: null },
}
```

## Bank-grade contracts

The SDK ships its own contracts registry — every behavioural guarantee the SDK makes (per-user cache isolation, deterministic Idempotency-Key, queue durability, etc.) lives in `contracts/**/*.json` at the monorepo root and is **bundled into every release**. The customer's lockfile pins SDK code + contracts atomically — drift between what the SDK does and what it claims is structurally impossible. See [`contracts/README.md`](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/README.md) for the full architecture.

### `CrossdeckContracts` — typed access to the bundled registry

```ts
import { CrossdeckContracts } from "@cross-deck/web";

CrossdeckContracts.all();                              // enforced contracts only
CrossdeckContracts.allIncludingHistorical();           // + proposed + retired
CrossdeckContracts.byId("per-user-cache-isolation");
CrossdeckContracts.byPillar("entitlements");
CrossdeckContracts.withStatus("proposed");
CrossdeckContracts.findByTestName("identify(B) makes A's entitlements unreachable from in-memory");
CrossdeckContracts.sdkVersion;        // "1.5.0"
CrossdeckContracts.bundledIn;         // "@cross-deck/web@1.5.0"
```

The `Contract` type is exported alongside; the binary-stability promise (which fields are guaranteed across patch/minor releases) is documented inline on `src/contracts.ts` and in [`contracts/README.md`](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/README.md).

### `Crossdeck.reportContractFailure(input)` — surface contract test failures

When a contract test asserts and fails — in your CI, a dogfood run, or a customer integration test — fire a typed `crossdeck.contract_failed` event over the **Crossdeck reliability channel**. This is one-way operational telemetry to the Crossdeck operations team (Privacy Policy §6, "Flow B"); it never enters your `track()` pipeline, never shows in your dashboard, never bills against your event quota. The wire shape is schema-locked at [`contracts/diagnostics/contract-failed-payload-schema-lock.json`](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/diagnostics/contract-failed-payload-schema-lock.json):

```ts
Crossdeck.reportContractFailure({
  contractId: "per-user-cache-isolation",
  failureReason: "expected isolation across user switch, got cross-read",
  runContext: process.env.CI ? "ci" : "dogfood",
  runId: process.env.GITHUB_RUN_ID ?? crypto.randomUUID(),
  testRef: {
    file: "tests/entitlement-cache-isolation.test.ts",
    name: "identify(B) makes A's entitlements unreachable from in-memory",
  },
});
```

No new endpoint, no special ingest path — the event lands in the same pipeline every other `track()` call does. It surfaces immediately in the dashboard's live event feed, the breakdown chart (group by `contract_id`, `sdk_platform`), and any alert rule with `event = crossdeck.contract_failed`.

Properties stamped on the wire:

| Property | Source |
|----------|--------|
| `contract_id` | caller |
| `sdk_version`, `sdk_platform` | auto-stamped by the SDK |
| `failure_reason`, `run_context`, `run_id` | caller |
| `test_file`, `test_name` | set when `testRef` is provided |
| `device_class` | optional, set by caller (categorical bucket) |
| `verification_phase` | auto-stamped when the runtime verifier layer (below) is the source — `boot` or `hot_path` |

The wire shape is locked by [`contracts/diagnostics/contract-failed-payload-schema-lock.json`](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/diagnostics/contract-failed-payload-schema-lock.json); per-SDK assertion tests gate it on every release.

For per-test-framework hooks (Vitest `afterEach`, etc.) see [`contracts/README.md` § Reporting contract failures](https://github.com/VistaApps-za/crossdeck/blob/main/contracts/README.md#reporting-contract-failures-back-to-crossdeck).

### Runtime self-verification (v1.5.1+)

The Web SDK actively tests its own structural contracts at runtime — not just in Crossdeck's CI. Every `init()` runs a boot self-test; every relevant SDK operation (`identify()`, `track()`, `syncPurchases()`, error parse) is observed by a hot-path verifier that asserts the contract claim held. PASS results stream to your devtools console; FAIL results stream silently to Crossdeck's reliability workspace via a dedicated one-way channel that never touches your appId, your dashboard, or your event quota.

```ts
Crossdeck.init({
  appId: "app_web_xxx",
  publicKey: "cd_pub_test_xxx",
  environment: "sandbox",
  // Defaults shown — both are true in dev (NODE_ENV !== "production"),
  // false in production. Set explicitly to override.
  verifyContractsAtBoot: true,   // run the boot self-test on init
  logVerifierResults: true,      // print PASS lines to console
  // Sovereignty kill-switch — disables the entire layer end-to-end:
  // no verifiers run, no console output, no reliability-channel
  // writes. Default false.
  disableContractAssertions: false,
});
```

What you'll see in your devtools console (with `logVerifierResults: true`):

```
[crossdeck] Contract self-verification — running 5 tests
   ✓ per-user-cache-isolation — slot rotated A:7c44…ee20 → B:a3f2…01b9
   ✓ idempotency-key-deterministic — apple JWS → a66b1640-…
   ✓ error-envelope-shape — { type, code, message, request_id } parsed
   ✓ flush-interval-parity — eventFlushIntervalMs = 2000ms
   ✓ super-property-merge-precedence — caller > super > device
[crossdeck] Self-verification passed — 5 passed, 0 failed (8ms)

[crossdeck.identify] ✓ per-user-cache-isolation — slot rotated _anon → a3f2…01b9
[crossdeck.track]    ✓ super-property-merge-precedence — caller(2) > super(1) > device
```

**Operator's-view configuration.** The same `verifyContractsAtBoot` + `logVerifierResults` flags are exposed as a per-app remote config in the dashboard at [/dashboard/apps/](https://cross-deck.com/dashboard/apps/). Flip a toggle there and the next SDK boot picks it up — no code change, no redeploy. Code wins on precedence (`code option > dashboard remote config > DEBUG/RELEASE default`), so engineers retain ultimate control. `disableContractAssertions` is intentionally code-only — see [docs/contracts/ § sovereignty](https://cross-deck.com/docs/contracts/#runtime-sovereignty).

Full architecture + per-verifier walkthrough at [docs/contracts/ § Runtime self-verification](https://cross-deck.com/docs/contracts/#runtime).

## Errors

Every async method can throw `CrossdeckError`. Synchronous methods throw on configuration mistakes (calling before `init()`, invalid key prefix, env mismatch).

```ts
import { CrossdeckError } from "@cross-deck/web";

try {
  await Crossdeck.identify("user_847");
} catch (err) {
  if (err instanceof CrossdeckError) {
    console.error(err.type, err.code, err.requestId);
    if (err.code === "invalid_api_key") {
      // ...
    }
  }
}
```

Error fields:

| Field | What it is |
|---|---|
| `type` | One of `authentication_error`, `permission_error`, `invalid_request_error`, `rate_limit_error`, `internal_error`, `network_error`, `configuration_error`. Same vocabulary the backend uses. |
| `code` | Specific machine-readable code, e.g. `invalid_api_key`, `origin_not_allowed`, `rate_limited`, `network_error`. |
| `message` | Human-readable description. |
| `requestId` | Server-issued ID. Echo it in support tickets — we'll have a one-line log entry that explains the decision. |
| `status` | HTTP status code if the error came from an API response. |

## Node usage

The SDK works the same way in Node 18+:

```ts
import { Crossdeck, MemoryStorage } from "@cross-deck/web";

Crossdeck.init({
  appId: process.env.CROSSDECK_APP_ID!,
  publicKey: process.env.CROSSDECK_PUBLIC_KEY!,
  environment: "sandbox",         // or "production"
  storage: new MemoryStorage(),   // session-only, no localStorage
  autoHeartbeat: false,           // skip the boot ping in scripts
});
```

For server-side flows where you need to read any customer's state (not just the caller's), use the **secret key** path — that ships when the `/v1/server/*` endpoints land.

## Security

Publishable keys aren't secrets — they're identifiers, safe to ship in client code. See [`docs/api-keys`](https://cross-deck.com/docs/api-keys/) for the full security model: how keys are stored, how requests are verified, what's enforced where. Highlights:

- **Origin allowlists** on web keys (configured in the Crossdeck dashboard) reject requests from unauthorised origins.
- **Tenant isolation** — a leaked key can read its own project's customer data only, never another tenant's.
- **Env partition** — a `cd_pub_live_…` key cannot read `cd_pub_test_…` data and vice versa.
- **No raw payment credentials** ever pass through this SDK or sit in a Crossdeck database. Apple `.p8`s, Stripe secret keys, Google service-account JSON — all in Google Cloud Secret Manager, runtime-only access from the Crossdeck backend.

## Identity & cookies (v0.6.0+)

The SDK persists `anonymousId` and `crossdeckCustomerId` so a returning user keeps the same Crossdeck identity across page loads. By default in browsers it writes to BOTH `localStorage` (primary) and a 1st-party `document.cookie` (secondary, `Path=/`, `Max-Age=2y`, `SameSite=Lax`, `Secure` over HTTPS). The redundancy keeps "10k unique visitors" actually meaning 10k humans even when one store is wiped by ITP, private browsing, or "clear site data."

The cookie holds only the same `anonymousId` already in `localStorage` — no fingerprintable data, no PII. Same security posture as Stripe, Segment, and PostHog's 1st-party identity cookies.

**Disabling persistence.** Customers running strict consent flows (e.g. cookies disabled until the visitor opts in via a consent banner) should pass `persistIdentity: false` to `Crossdeck.init`. That switches the SDK to in-memory only — no `localStorage`, no cookie, identity is recreated on every page load. Re-`init` with `persistIdentity: true` once consent lands.

```ts
Crossdeck.init({
  appId, publicKey, environment,
  persistIdentity: false,  // strict consent — opt in later
});
```

**Cookie disclosure.** If your privacy policy enumerates cookies, list this one as a "1st-party functional / analytics cookie used to keep the same visitor identity across page loads." The Crossdeck cookie name uses the configured `storagePrefix` (default `crossdeck:`) followed by `anon_id` (and `cdcust_id` once a user signs in).

## Versioning

This package follows [semver](https://semver.org). The wire-format types (`PublicEntitlement`, `AliasResult`, etc.) are duplicated from the backend's `v1-types.ts` — they're the stable contract, not a shared module. Breaking changes to those types only ship in major versions.

## License

MIT.
