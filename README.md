# @cross-deck/web

The Crossdeck SDK for browsers and Node.js. One package, one mental model, every Crossdeck client API in five lines of setup.

```bash
npm install @cross-deck/web
```

## Quick start

```ts
import { Crossdeck } from "@cross-deck/web";

// 1. Boot once at app start
Crossdeck.start({ publicKey: "cd_pub_live_…" });

// 2. After the user logs in, link the device to your user ID
await Crossdeck.identify("user_847");

// 3. Read entitlements (warms the local cache)
await Crossdeck.getEntitlements();

// 4. Sync access checks (microsecond reads from cache)
if (Crossdeck.isEntitled("pro")) {
  showProFeatures();
}

// 5. Telemetry — fire-and-forget, batched in the background
Crossdeck.track("paywall_viewed", { variant: "v3" });
```

That's the full happy path.

## What it does

- **One identity for every device + user.** Pre-login events get an `anonymousId`. After login, `identify()` links them to your user ID through Crossdeck's identity graph. The SDK persists both so subsequent app launches resume where you left off.
- **Synchronous entitlement reads.** `getEntitlements()` populates a local cache. `isEntitled("pro")` is a Set lookup — no network call, no waiting.
- **Batched telemetry.** `track()` queues events in memory; the SDK flushes every 5 seconds (configurable) or when the buffer hits 20 events. Network failures re-queue the batch — events aren't lost on a flaky connection.
- **Boot heartbeat.** On `start()` the SDK pings `/v1/sdk/heartbeat` so the dashboard's Apps page can show you "last seen" per install. Disable with `autoHeartbeat: false`.
- **Stripe-style errors.** Every async method throws `CrossdeckError` with `type`, `code`, `requestId`, and `status` — same shape as Stripe's SDKs, so generic error handlers transfer.

## API

### `Crossdeck.start(options)`

Boot the client. Idempotent — calling twice with the same options is fine.

```ts
Crossdeck.start({
  publicKey: "cd_pub_live_…",         // required
  baseUrl: "https://api.cross-deck.com/v1",  // override for self-host or emulator
  autoHeartbeat: true,                // default; set false for high-frequency boots
  eventFlushBatchSize: 20,            // default
  eventFlushIntervalMs: 5_000,        // default
  storage: customStorage,             // override the persistence adapter
});
```

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

### `await Crossdeck.getEntitlements()`

Fetch the current customer's active entitlements. Returns an array of `PublicEntitlement` and updates the local cache.

```ts
const ents = await Crossdeck.getEntitlements();
// [{ object: "entitlement", key: "pro", isActive: true, validUntil: 1717891200, source: {...}, updatedAt: ... }]
```

### `Crossdeck.isEntitled(key) → boolean`

Synchronous read from the local cache. Returns `false` until you've called `getEntitlements()` once (or `purchaseApple()` resolved). After that, it's a Set lookup — call as often as you want.

### `Crossdeck.track(name, properties?)`

Queue a telemetry event. Returns immediately. Events flush in batches; force a flush with `flushEvents()`:

```ts
Crossdeck.track("checkout_started", { product: "annual_pro" });
// …later, e.g. before page unload:
window.addEventListener("beforeunload", () => {
  void Crossdeck.flushEvents();
});
```

Event names match `[A-Za-z0-9_.\-:]+`, max 128 chars. Properties are JSON-serialisable, max 8 KB per event after JSON encoding.

### `await Crossdeck.purchaseApple(input)`

Forward a StoreKit 2 transaction directly to Crossdeck for verification — closes the purchase-to-entitled latency from seconds to milliseconds (faster than waiting for the App Store webhook).

```ts
await Crossdeck.purchaseApple({
  signedTransactionInfo: transaction.jsonRepresentation,  // from StoreKit 2
  signedRenewalInfo: subscription.signedRenewalInfo,      // optional
  appAccountToken: "uuid-…",                              // optional
});
```

Stripe and Google purchases are verified via webhooks (Stripe Connect platform endpoint, Google Play RTDN) — there's no SDK-side push for those.

### `await Crossdeck.heartbeat()`

Manually send a heartbeat. Called automatically by `start()` unless `autoHeartbeat: false`. Returns the readiness summary the dashboard uses to display SDK installation status.

### `Crossdeck.reset()`

Wipe persisted identity + entitlement cache + queued events. Call on logout. The next session generates a fresh `anonymousId` and starts a clean identity-graph entry.

### `Crossdeck.flushEvents()`

Force-flush the in-memory event queue. Useful before page unload or when shutting down a script.

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

## Errors

Every async method can throw `CrossdeckError`. Synchronous methods throw on configuration mistakes (calling before `start()`, invalid key prefix).

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

Crossdeck.start({
  publicKey: process.env.CROSSDECK_PUBLIC_KEY!,
  storage: new MemoryStorage(),  // session-only, no localStorage
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

## Versioning

This package follows [semver](https://semver.org). The wire-format types (`PublicEntitlement`, `AliasResult`, etc.) are duplicated from the backend's `v1-types.ts` — they're the stable contract, not a shared module. Breaking changes to those types only ship in major versions.

## License

MIT.
