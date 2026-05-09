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
}

/** Auto-tracking flags. See CrossdeckOptions.autoTrack. */
export interface AutoTrackOptions {
  /** Emit `session.started` / `session.ended` automatically. Default true (browser only). */
  sessions: boolean;
  /** Emit `page.viewed` on initial load + SPA navigation. Default true (browser only). */
  pageViews: boolean;
  /** Auto-attach os/browser/locale/screen/etc to every event's `properties`. Default true (browser only). */
  deviceInfo: boolean;
}

/** Minimal interface for any pluggable key-value persistence. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Identity hint object passed to identify() — at least one field required. */
export interface IdentifyOptions {
  /** Optional email to attach to the customer record. */
  email?: string;
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
  entitlements: {
    count: number;
    lastUpdated: number;
  };
  events: {
    buffered: number;
    dropped: number;
    inFlight: number;
    lastFlushAt: number;
    lastError: string | null;
  };
}
