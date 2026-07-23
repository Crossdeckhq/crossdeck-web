/**
 * Public types for @cross-deck/web. These mirror the wire format
 * exposed by the v1 backend API. Keep them in lockstep with
 * backend/src/api/v1-types.ts — same field names, same nullability.
 */

export type Environment = "production" | "sandbox";
export type Platform = "ios" | "android" | "web";

export type AuditRail = "apple" | "stripe" | "google" | "manual";

export interface PublicEntitlement {
  object: "entitlement";
  key: string;
  isActive: boolean;
  validUntil?: number | null;
  source: {
    rail: AuditRail;
    productId: string;
    subscriptionId: string;
  };
  updatedAt: number;
}

export interface EntitlementsListResponse {
  object: "list";
  data: PublicEntitlement[];
  crossdeckCustomerId: string;
  env: Environment;
}

export interface AliasResult {
  object: "alias_result";
  crossdeckCustomerId: string;
  linked: Array<
    | { type: "developer"; id: string }
    | { type: "anonymous"; id: string }
  >;
  mergePending: boolean;
  env: Environment;
}

export interface IngestResponse {
  object: "list";
  received: number;
  env: Environment;
}

export interface PurchaseResult {
  object: "purchase_result";
  crossdeckCustomerId: string;
  env: Environment;
  entitlements: PublicEntitlement[];
  /** True when the response came from the backend's idempotency
   * cache instead of fresh processing. Backend also returns
   * `Idempotent-Replayed: true` as a response header (v1.4.0). */
  idempotent_replay?: boolean;
}

export interface HeartbeatResponse {
  object: "heartbeat";
  ok: true;
  projectId: string;
  appId: string;
  platform: Platform;
  env: Environment;
  serverTime: number;
}

/**
 * Configuration for Crossdeck.init. Three fields are mandatory —
 * `appId`, `publicKey`, and `environment` — per NorthStar §11.1.
 *
 * The pair of (appId, environment) is what we put on the wire envelope
 * (NorthStar §13.1) so the backend can correlate events against the
 * specific app surface and refuse mismatched env declarations loudly.
 */
export interface CrossdeckOptions {
  /**
   * Your Crossdeck App ID (e.g. "app_web_xxx"). Required.
   *
   * Issued in the dashboard when you create an app. Goes on the wire
   * envelope so the backend correlates events with the specific app
   * surface — useful when one project has multiple apps (web + iOS +
   * Android) sharing the same publishable key family.
   */
  appId: string;
  /** Your Crossdeck publishable key (cd_pub_…). Required. */
  publicKey: string;
  /**
   * Explicit environment declaration. Required.
   *
   * Must match the publishable key's prefix:
   *   cd_pub_test_…  → "sandbox"
   *   cd_pub_live_…  → "production"
   *
   * Mismatch is rejected at init time so a typo'd key can't silently
   * route prod telemetry into sandbox dashboards.
   */
  environment: Environment;
  /**
   * Override the API base URL. Default is https://api.cross-deck.com/v1.
   * Useful for self-hosted setups or pointing at the local emulator
   * (e.g. http://localhost:5001/crossdeck-47d8f/us-east4/v1).
   */
  baseUrl?: string;
  /**
   * Persist anonymousId + crossdeckCustomerId across sessions.
   * Default: true in the browser (localStorage), false in Node (in-memory only).
   */
  persistIdentity?: boolean;
  /**
   * Storage adapter. The SDK calls .getItem / .setItem / .removeItem.
   * Defaults to globalThis.localStorage when present. Pass an in-memory
   * adapter for Node runtimes where you want session-only persistence.
   */
  storage?: KeyValueStorage;
  /** Storage key prefix for the SDK's persisted state. Default "crossdeck:". */
  storagePrefix?: string;
  /**
   * Cross-subdomain identity. The anonymous-ID cookie is scoped to this domain so
   * a visitor is ONE person across every subdomain — your marketing site
   * (`example.com`) and your app (`app.example.com`) share one identity, so
   * first-touch source, journey, and conversion stitch into one timeline.
   *
   *   - `"auto"` (default) — the registrable domain (eTLD+1), detected safely.
   *   - a domain string (`".example.com"` / `"example.com"`) — set it explicitly.
   *   - `"none"` — host-only (each subdomain is its own identity; pre-1.11 behaviour).
   *
   * No effect in Node/native — cookies + subdomains are browser-only. Cross-*device*
   * / cross-platform identity is resolved server-side by email/userId, not here.
   */
  cookieDomain?: string;
  /**
   * Send a heartbeat to /v1/sdk/heartbeat on start(). Default true.
   * Disable for high-frequency boot scenarios where the heartbeat is
   * pure overhead.
   */
  autoHeartbeat?: boolean;
  /** Maximum events buffered before forced flush. Default 20. */
  eventFlushBatchSize?: number;
  /** Idle ms after the last track() before flushing. Default 5000. */
  eventFlushIntervalMs?: number;
  /** Override the SDK version reported on heartbeats. Default: package version. */
  sdkVersion?: string;
  /**
   * Auto-tracking. Default: every flag is `true` in browsers, all
   * silently no-op in Node.
   *
   * Pass `false` to disable everything, or a partial object to override
   * individual flags:
   *
   *   Crossdeck.start({
   *     publicKey: "...",
   *     autoTrack: { pageViews: false }, // sessions + deviceInfo still on
   *   });
   */
  autoTrack?: boolean | Partial<AutoTrackOptions>;
  /**
   * Your app's version (e.g. "1.2.3"). Auto-attached to every event as
   * `properties.appVersion` when `autoTrack.deviceInfo` is enabled.
   * Useful for slicing dashboards by build.
   */
  appVersion?: string;
  /**
   * Enable verbose diagnostic logging via the NorthStar §16 debug-signal
   * vocabulary. Default: false. Equivalent to calling
   * `Crossdeck.setDebugMode(true)` after init.
   */
  debug?: boolean;
  /**
   * Respect the browser's Do Not Track signal at init (v0.10.0+).
   * Default `false`. When `true` AND the user has `navigator.doNotTrack === "1"`,
   * the SDK boots with analytics / marketing / errors all denied —
   * locked off even if the developer later calls `Crossdeck.consent({...})`.
   * Industry has effectively deprecated DNT, but opt-in support is the
   * polite default for privacy-first apps.
   */
  respectDnt?: boolean;
  /**
   * Scrub PII-shaped strings (email addresses, card numbers) from
   * URL paths, event properties, and acquisition referrer before they
   * leave the SDK. Default `true` — Stripe-grade. Disable only if your
   * pipeline does its own PII redaction downstream and you need the
   * raw strings.
   */
  scrubPii?: boolean;
  /**
   * Run the contract self-verification suite at SDK boot. Defaults
   * to `true` in development (`process.env.NODE_ENV !== "production"`),
   * `false` in production. Pass `true` explicitly to opt-in for
   * production (e.g. during a staging soak); pass `false` to silence
   * the boot self-test in development.
   *
   * What this is: the boot self-test runs every applicable runtime
   * verifier against an isolated test context — `EntitlementCache`,
   * `deriveIdempotencyKeyForPurchase`, `crossdeckErrorFromResponse`,
   * etc. are exercised against synthetic state. The customer's real
   * SDK state is never mutated. The output proves at runtime that
   * the platform's structural guarantees — per-user cache isolation,
   * idempotency-key determinism, error-envelope shape, payload
   * schema-lock — actually hold, not just in Crossdeck's CI.
   * See `docs/contracts/index.html` for the full ledger.
   *
   * Boot-time PASS results print to the console iff
   * `logVerifierResults` is `true`. Boot-time FAIL results ALWAYS
   * print at WARN and fire `reportContractFailure(...)` to
   * Crossdeck's reliability channel (with `verification_phase: "boot"`)
   * — silencing a boot failure would defeat the purpose, since a
   * structural break at boot means the SDK is broken before the
   * customer's first user even taps. To stop the failure reporting,
   * use `disableContractAssertions: true`. To stop the console
   * passes, use `logVerifierResults: false`. The flags are
   * independent.
   */
  verifyContractsAtBoot?: boolean;
  /**
   * Whether to print PASS results from the contract verifier layer
   * to the console (`[crossdeck.identify] ✓ per-user-cache-isolation
   * — slot rotated …`). Defaults to `true` in development, `false`
   * in production.
   *
   * Cosmetic flag — controls console output only. Failure reporting
   * to Crossdeck's reliability channel is NOT affected by this flag;
   * a contract violation always prints at WARN and always fires
   * `reportContractFailure(...)` regardless. To stop the reliability
   * reporting, use `disableContractAssertions: true` instead.
   *
   * Pass `true` in a staging or QA build to verify the SDK is
   * honouring its own contracts as your engineer exercises the app
   * — every `identify()`, `track()`, `syncPurchases()` will stream
   * a verifier line through the browser devtools console.
   */
  logVerifierResults?: boolean;
  /**
   * Disable the entire contract verifier + failure-reporting layer.
   * Default `false`.
   *
   * When `false` (default): verifiers run on every hot-path SDK
   * operation (identify / track / syncPurchases / isEntitled / error
   * parse). PASS results are silent unless `logVerifierResults` is
   * `true`. FAIL results always print at WARN AND fire
   * `reportContractFailure(...)` to Crossdeck's reliability endpoint
   * over a single-fire one-way path. This is the independent-
   * controller flow described in Privacy Policy §6 ("Flow B"); the
   * payload is schema-locked to contain no end-user identifiers.
   *
   * When `true`: every verifier is disabled. The runtime continues
   * to behave correctly — verifiers are observers, not assertions
   * — but the verification + reporting layer is silent end-to-end.
   * No console output, no telemetry, no reliability-channel writes.
   *
   * Use this only if your sovereignty posture forbids any outbound
   * diagnostic telemetry to third-party controllers. This is NOT
   * the right tool for silencing the console — for that, set
   * `logVerifierResults: false` and leave this flag untouched.
   */
  disableContractAssertions?: boolean;
}

/** Auto-tracking flags. See CrossdeckOptions.autoTrack. */
export interface AutoTrackOptions {
  /** Emit `session.started` / `session.ended` automatically. Default true (browser only). */
  sessions: boolean;
  /** Emit `page.viewed` on initial load + SPA navigation. Default true (browser only). */
  pageViews: boolean;
  /** Auto-attach os/browser/locale/screen/etc to every event's `properties`. Default true (browser only). */
  deviceInfo: boolean;
  /**
   * Click autocapture — fire `element.clicked` for every interactive
   * click on the page. Default true. Mixpanel/Amplitude pattern. Powers
   * Crossdeck's funnel-attribution USP ("clicked X then converted").
   * Privacy: skips form inputs / password fields / [class~="cd-noTrack"]
   * subtrees. Override on individual elements with data-cd-event="custom"
   * or data-cd-prop-* for custom property tagging.
   */
  clicks: boolean;
  /**
   * Web Vitals capture (v0.9.0+) — emits `webvitals.lcp`, `webvitals.inp`,
   * `webvitals.cls`, `webvitals.fcp`, `webvitals.ttfb` events using the
   * browser's `PerformanceObserver`. Defaults to true in browsers,
   * no-op everywhere else. Disable if you have a separate RUM provider
   * (DataDog, Sentry Performance) and don't want duplicates.
   */
  webVitals: boolean;
  /**
   * Error capture (v1.0.0+) — installs window.onerror +
   * window.onunhandledrejection listeners, wraps fetch + XHR to catch
   * 5xx + network failures, ships each captured error as a Crossdeck
   * event (kind: error.unhandled / error.unhandledrejection /
   * error.handled / error.http / error.message). Errors gate on
   * `consent.errors`. Rate-limited per-fingerprint so a runaway loop
   * can't flood the queue; browser-extension noise filtered by
   * default. Default true in browsers, no-op everywhere else.
   */
  errors: boolean;
}

/** Minimal interface for any pluggable key-value persistence. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Identity hint + profile traits passed to identify().
 *
 * `traits` is a free-form bag of profile data (name, plan, signupDate,
 * teamRole, etc.) that gets persisted on the Crossdeck customer record
 * and attached to every subsequent event of the identified user as
 * `$user.<key>` properties for dashboard filtering.
 *
 * Like event properties, traits are validated at the SDK boundary —
 * functions/symbols/undefined dropped, Date / BigInt / Error coerced,
 * strings > 1024 chars truncated. Caller's object is never mutated.
 */
export interface IdentifyOptions {
  /** Optional email to attach to the customer record. */
  email?: string;
  /**
   * Optional profile traits. Examples:
   *   `{ name: "Wes", plan: "pro", signedUpAt: "2026-05-11" }`
   *
   * Treated like event properties — values are sanitised at the SDK
   * boundary so a `{ avatar: <File>, callback: () => {} }` payload
   * doesn't crash the alias request. Server-side, traits land on
   * `customers/{cdcust}.traits` (additively — existing fields are
   * preserved unless the new identify call overrides them).
   */
  traits?: Record<string, unknown>;
}

/**
 * Group context — Mixpanel-style. Identifies a customer's membership
 * in an organisational entity (org, account, team, workspace) so B2B
 * dashboards can answer "how is account X using my product".
 *
 * Attached to every event as `$groups.<type>` until cleared via
 * `Crossdeck.group(type, null)`. Multiple types can coexist (e.g.
 * `org` + `team`) — the SDK keeps a map keyed by type.
 */
export interface GroupTraits {
  [key: string]: unknown;
}

/** Properties payload for track(). Arbitrary key/value, JSON-serialisable, ≤ 8 KB. */
export type EventProperties = Record<string, unknown>;

/**
 * Diagnostic snapshot returned by Crossdeck.diagnostics(). Stable shape
 * whether or not start() has been called — callers don't need to narrow
 * on `started` to read `events` or `entitlements`. Pre-start values are
 * sensible empties (zeros, nulls).
 */
export interface Diagnostics {
  started: boolean;
  anonymousId: string | null;
  crossdeckCustomerId: string | null;
  developerUserId: string | null;
  sdkVersion: string | null;
  baseUrl: string | null;
  /**
   * Last `serverTime` value the SDK saw on a /sdk/heartbeat response,
   * along with the local clock value AT that moment. Lets dashboards
   * (and the developer, in debug mode) detect a wrong-system-clock
   * problem before it corrupts a day of analytics. Null until the
   * first heartbeat completes.
   */
  clock: {
    /** Server's view of "now" from the last heartbeat (epoch ms). */
    lastServerTime: number | null;
    /** Client's `Date.now()` taken at the same moment as `lastServerTime`. */
    lastClientTime: number | null;
    /**
     * `lastClientTime - lastServerTime` — positive means the client
     * clock is AHEAD of the server. Outside ±5 minutes is suspicious
     * and worth surfacing to the developer.
     */
    skewMs: number | null;
  };
  entitlements: {
    count: number;
    lastUpdated: number;
    /**
     * True when the durable cache is knowingly serving older-than-
     * trustworthy data — the last refresh attempt failed (Crossdeck
     * unreachable) or last-known-good has aged past the staleness
     * window. The cache still serves last-known-good; this makes the
     * staleness observable instead of a silent unbounded window.
     */
    stale: boolean;
    /**
     * Cumulative count of listener invocations that threw. Swallowed
     * inside the cache (a buggy consumer must not crash the SDK) but
     * surfaced here so developers can spot broken subscribers.
     */
    listenerErrors: number;
  };
  events: {
    buffered: number;
    dropped: number;
    inFlight: number;
    lastFlushAt: number;
    lastError: string | null;
    /** Consecutive flush failures since the last success. */
    consecutiveFailures: number;
    /**
     * When the next retry is scheduled (epoch ms), or null if the queue
     * is idle / healthy.
     */
    nextRetryAt: number | null;
  };
}
