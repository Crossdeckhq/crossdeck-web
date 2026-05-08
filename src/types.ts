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
 * Configuration for Crossdeck.start. Most fields have sensible defaults
 * — only `publicKey` is mandatory.
 */
export interface CrossdeckOptions {
  /** Your Crossdeck publishable key (cd_pub_…). Required. */
  publicKey: string;
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
