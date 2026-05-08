/**
 * Public API surface for @cross-deck/web.
 *
 * Usage (browser):
 *
 *   import { Crossdeck } from "@cross-deck/web";
 *
 *   Crossdeck.start({ publicKey: "cd_pub_live_…" });
 *
 *   await Crossdeck.identify("user_847");
 *   const ents = await Crossdeck.getEntitlements();
 *   if (Crossdeck.isEntitled("pro")) {
 *     showPro();
 *   }
 *   Crossdeck.track("paywall_shown", { variant: "v3" });
 *
 *
 * Usage (Node):
 *
 *   import { Crossdeck } from "@cross-deck/web";
 *   import { MemoryStorage } from "@cross-deck/web";
 *
 *   Crossdeck.start({
 *     publicKey: "cd_pub_test_…",
 *     storage: new MemoryStorage(),  // session-only persistence
 *     autoHeartbeat: false,           // skip the boot ping in scripts
 *   });
 */

import { CrossdeckError } from "./errors";
import { HttpClient, SDK_VERSION, DEFAULT_BASE_URL } from "./http";
import { IdentityStore } from "./identity";
import { EntitlementCache } from "./entitlement-cache";
import { EventQueue, type QueuedEvent } from "./event-queue";
import { detectDefaultStorage, MemoryStorage } from "./storage";
import { randomChars } from "./identity";
import type {
  AliasResult,
  CrossdeckOptions,
  Diagnostics,
  EntitlementsListResponse,
  EventProperties,
  HeartbeatResponse,
  IdentifyOptions,
  PublicEntitlement,
  PurchaseResult,
} from "./types";

interface InternalState {
  http: HttpClient;
  identity: IdentityStore;
  entitlements: EntitlementCache;
  events: EventQueue;
  options: Required<Omit<CrossdeckOptions, "storage" | "sdkVersion">> & {
    sdkVersion: string;
  };
  developerUserId: string | null;
}

export class CrossdeckClient {
  private state: InternalState | null = null;

  /**
   * Boot the SDK. Idempotent — calling start twice with the same options
   * is a no-op; calling with different options replaces the previous
   * configuration.
   */
  start(options: CrossdeckOptions): void {
    if (!options.publicKey || !options.publicKey.startsWith("cd_pub_")) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "invalid_public_key",
        message: "Crossdeck.start requires a publishable key starting with cd_pub_.",
      });
    }

    const storage = options.storage ?? detectDefaultStorage();
    const persistIdentity = options.persistIdentity ?? true;
    const opts: InternalState["options"] = {
      publicKey: options.publicKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      persistIdentity,
      storagePrefix: options.storagePrefix ?? "crossdeck:",
      autoHeartbeat: options.autoHeartbeat ?? true,
      eventFlushBatchSize: options.eventFlushBatchSize ?? 20,
      eventFlushIntervalMs: options.eventFlushIntervalMs ?? 5000,
      sdkVersion: options.sdkVersion ?? SDK_VERSION,
    };

    const http = new HttpClient({
      publicKey: opts.publicKey,
      baseUrl: opts.baseUrl,
      sdkVersion: opts.sdkVersion,
    });
    const effectiveStorage = persistIdentity ? storage : new MemoryStorage();
    const identity = new IdentityStore(effectiveStorage, opts.storagePrefix);
    const entitlements = new EntitlementCache();
    const events = new EventQueue({
      http,
      batchSize: opts.eventFlushBatchSize,
      intervalMs: opts.eventFlushIntervalMs,
    });

    this.state = {
      http,
      identity,
      entitlements,
      events,
      options: opts,
      developerUserId: null,
    };

    if (opts.autoHeartbeat) {
      // Fire-and-forget — heartbeat failure shouldn't block start().
      void this.heartbeat().catch(() => undefined);
    }
  }

  /**
   * Link the anonymous device to a developer-supplied user ID. Cache
   * the resolved Crossdeck customer for follow-up calls.
   */
  async identify(userId: string, _options?: IdentifyOptions): Promise<AliasResult> {
    const s = this.requireStarted();
    if (!userId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_user_id",
        message: "identify(userId) requires a non-empty userId.",
      });
    }
    const result = await s.http.request<AliasResult>("POST", "/identity/alias", {
      body: { userId, anonymousId: s.identity.anonymousId },
    });
    s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    s.developerUserId = userId;
    return result;
  }

  /**
   * Read the current customer's active entitlements from the server.
   * Updates the local cache so subsequent isEntitled() calls answer
   * synchronously.
   */
  async getEntitlements(): Promise<PublicEntitlement[]> {
    const s = this.requireStarted();
    const query = this.identityQueryParams();
    const result = await s.http.request<EntitlementsListResponse>(
      "GET",
      "/entitlements",
      { query }
    );
    if (result.crossdeckCustomerId) {
      s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    }
    s.entitlements.setFromList(result.data);
    return result.data;
  }

  /**
   * Synchronous read from the local cache. Returns false if the cache
   * has never been populated (call getEntitlements first to warm it).
   */
  isEntitled(key: string): boolean {
    const s = this.requireStarted();
    return s.entitlements.isEntitled(key);
  }

  /** Snapshot of the local entitlement cache. */
  listEntitlements(): PublicEntitlement[] {
    const s = this.requireStarted();
    return s.entitlements.list();
  }

  /**
   * Queue a telemetry event. Returns immediately — the network round-
   * trip happens in the background. To flush before the page unloads,
   * call flushEvents().
   */
  track(name: string, properties?: EventProperties): void {
    const s = this.requireStarted();
    if (!name) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_name",
        message: "track(name) requires a non-empty name.",
      });
    }
    const event: QueuedEvent = {
      eventId: this.mintEventId(),
      name,
      timestamp: Date.now(),
      properties: properties ?? {},
    };
    Object.assign(event, this.identityHintForEvent());
    s.events.enqueue(event);
  }

  /** Force-flush queued events. Useful to call from page-unload handlers. */
  async flushEvents(): Promise<void> {
    const s = this.requireStarted();
    await s.events.flush();
  }

  /** Forward an Apple StoreKit 2 transaction for verification + projection. */
  async purchaseApple(input: {
    signedTransactionInfo: string;
    signedRenewalInfo?: string;
    appAccountToken?: string;
  }): Promise<PurchaseResult> {
    const s = this.requireStarted();
    if (!input.signedTransactionInfo) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_signed_transaction_info",
        message: "purchaseApple requires a signedTransactionInfo string from StoreKit 2.",
      });
    }
    const result = await s.http.request<PurchaseResult>("POST", "/purchases", {
      body: { rail: "apple", ...input },
    });
    s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    s.entitlements.setFromList(result.entitlements);
    return result;
  }

  /**
   * Send the boot heartbeat. Called automatically by start() unless
   * autoHeartbeat:false. Safe to call manually as a "we're still here" ping.
   */
  async heartbeat(): Promise<HeartbeatResponse> {
    const s = this.requireStarted();
    return await s.http.request<HeartbeatResponse>("GET", "/sdk/heartbeat");
  }

  /**
   * Wipe persisted identity + entitlement cache. Use on logout. The
   * next pre-login session generates a fresh anonymousId and starts a
   * new identity-graph entry.
   */
  reset(): void {
    if (!this.state) return;
    this.state.identity.reset();
    this.state.entitlements.clear();
    this.state.events.reset();
    this.state.developerUserId = null;
  }

  /**
   * Diagnostic: current state + queue stats. Useful for the dashboard's
   * heartbeat row and debugging in dev.
   *
   * Returns a stable shape regardless of whether start() has been called —
   * callers don't need to narrow on `started` to access `events` or
   * `entitlements`. Pre-start values are sensible empties.
   */
  diagnostics(): Diagnostics {
    if (!this.state) {
      return {
        started: false,
        anonymousId: null,
        crossdeckCustomerId: null,
        developerUserId: null,
        sdkVersion: null,
        baseUrl: null,
        entitlements: { count: 0, lastUpdated: 0 },
        events: {
          buffered: 0,
          dropped: 0,
          inFlight: 0,
          lastFlushAt: 0,
          lastError: null,
        },
      };
    }
    const s = this.state;
    return {
      started: true,
      anonymousId: s.identity.anonymousId,
      crossdeckCustomerId: s.identity.crossdeckCustomerId,
      developerUserId: s.developerUserId,
      sdkVersion: s.options.sdkVersion,
      baseUrl: s.options.baseUrl,
      entitlements: {
        count: s.entitlements.list().length,
        lastUpdated: s.entitlements.freshness,
      },
      events: s.events.getStats(),
    };
  }

  // ---------- private helpers ----------

  private requireStarted(): InternalState {
    if (!this.state) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "not_started",
        message: "Call Crossdeck.start({ publicKey }) before any other method.",
      });
    }
    return this.state;
  }

  /**
   * Build the identity query for /v1/entitlements. Priority:
   *   crossdeckCustomerId > developerUserId > anonymousId
   * — matches the resolveCrossdeckCustomerId precedence on the server.
   */
  private identityQueryParams(): Record<string, string | undefined> {
    const s = this.requireStarted();
    if (s.identity.crossdeckCustomerId) {
      return { customerId: s.identity.crossdeckCustomerId };
    }
    if (s.developerUserId) return { userId: s.developerUserId };
    return { anonymousId: s.identity.anonymousId };
  }

  /** Pick the right identity hint to embed on a queued event. */
  private identityHintForEvent(): Pick<
    QueuedEvent,
    "developerUserId" | "anonymousId" | "crossdeckCustomerId"
  > {
    const s = this.requireStarted();
    if (s.identity.crossdeckCustomerId) {
      return { crossdeckCustomerId: s.identity.crossdeckCustomerId };
    }
    if (s.developerUserId) return { developerUserId: s.developerUserId };
    return { anonymousId: s.identity.anonymousId };
  }

  private mintEventId(): string {
    const ts = Date.now().toString(36);
    return `evt_${ts}${randomChars(8)}`;
  }
}

/**
 * Default singleton — most consumers want one SDK instance per app.
 * Creating extra instances is fine; just `new CrossdeckClient()`.
 */
export const Crossdeck = new CrossdeckClient();
