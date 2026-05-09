/**
 * Public API surface for @cross-deck/web.
 *
 * Usage (browser):
 *
 *   import { Crossdeck } from "@cross-deck/web";
 *
 *   Crossdeck.init({
 *     appId: "app_web_xxx",
 *     publicKey: "cd_pub_live_…",
 *     environment: "production",
 *   });
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
 *   import { Crossdeck, MemoryStorage } from "@cross-deck/web";
 *
 *   Crossdeck.init({
 *     appId: "app_node_xxx",
 *     publicKey: "cd_pub_test_…",
 *     environment: "sandbox",
 *     storage: new MemoryStorage(),  // session-only persistence
 *     autoHeartbeat: false,           // skip the boot ping in scripts
 *   });
 */

import { CrossdeckError } from "./errors";
import { HttpClient, SDK_NAME, SDK_VERSION, DEFAULT_BASE_URL } from "./http";
import { IdentityStore } from "./identity";
import { EntitlementCache, type EntitlementsListener } from "./entitlement-cache";
import { EventQueue, type QueuedEvent } from "./event-queue";
import { detectDefaultStorage, MemoryStorage } from "./storage";
import { randomChars } from "./identity";
import { collectDeviceInfo, type DeviceInfo } from "./device-info";
import { AutoTracker, DEFAULT_AUTO_TRACK, type AutoTrackConfig } from "./auto-track";
import { ConsoleDebugLogger, findSensitivePropertyKeys, type DebugLogger } from "./debug";
import type {
  AliasResult,
  AutoTrackOptions,
  CrossdeckOptions,
  Diagnostics,
  EntitlementsListResponse,
  Environment,
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
  autoTracker: AutoTracker | null;
  /** Cached enrichment payload merged into every event's properties. */
  deviceInfo: DeviceInfo;
  options: Required<
    Omit<
      CrossdeckOptions,
      "storage" | "sdkVersion" | "autoTrack" | "appVersion" | "debug"
    >
  > & {
    sdkVersion: string;
    autoTrack: AutoTrackConfig;
    appVersion: string | null;
  };
  debug: DebugLogger;
  developerUserId: string | null;
}

export class CrossdeckClient {
  private state: InternalState | null = null;

  /**
   * Boot the SDK. Idempotent — calling init twice with the same options
   * is a no-op; calling with different options replaces the previous
   * configuration.
   *
   * NorthStar §11.1: signature is `Crossdeck.init({ appId, publicKey,
   * environment })`. The trio is validated up-front so a typo'd key or a
   * mismatched env fails fast at boot rather than at first event-flush.
   */
  init(options: CrossdeckOptions): void {
    if (!options.publicKey || !options.publicKey.startsWith("cd_pub_")) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "invalid_public_key",
        message: "Crossdeck.init requires a publishable key starting with cd_pub_.",
      });
    }
    if (!options.appId) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "missing_app_id",
        message: "Crossdeck.init requires an appId. Find yours in the Crossdeck dashboard.",
      });
    }
    if (options.environment !== "production" && options.environment !== "sandbox") {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "invalid_environment",
        message: 'Crossdeck.init requires environment: "production" | "sandbox".',
      });
    }
    // Key prefix must match the declared environment, otherwise prod
    // telemetry could silently route into sandbox dashboards (or vice
    // versa). NorthStar §15 calls this out as a "fail loudly" condition.
    const keyEnv = inferEnvFromKey(options.publicKey);
    if (keyEnv && keyEnv !== options.environment) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "environment_mismatch",
        message: `Crossdeck.init: environment "${options.environment}" disagrees with key prefix (${keyEnv}). Reconcile the publishable key with the environment declaration.`,
      });
    }

    const storage = options.storage ?? detectDefaultStorage();
    const persistIdentity = options.persistIdentity ?? true;
    const autoTrack = resolveAutoTrack(options.autoTrack);
    const opts: InternalState["options"] = {
      appId: options.appId,
      publicKey: options.publicKey,
      environment: options.environment,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      persistIdentity,
      storagePrefix: options.storagePrefix ?? "crossdeck:",
      autoHeartbeat: options.autoHeartbeat ?? true,
      eventFlushBatchSize: options.eventFlushBatchSize ?? 20,
      eventFlushIntervalMs: options.eventFlushIntervalMs ?? 5000,
      sdkVersion: options.sdkVersion ?? SDK_VERSION,
      autoTrack,
      appVersion: options.appVersion ?? null,
    };

    const debug = new ConsoleDebugLogger();
    debug.enabled = options.debug === true;

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
      envelope: () => ({
        appId: opts.appId,
        environment: opts.environment,
        sdk: { name: SDK_NAME, version: opts.sdkVersion },
      }),
      onFirstFlushSuccess: () => {
        debug.emit(
          "sdk.first_event_sent",
          "First telemetry event received. View it in Live Events.",
          { appId: opts.appId, environment: opts.environment },
        );
      },
    });

    // Collect device info ONCE at boot; cheap to re-use on every event.
    const deviceInfo: DeviceInfo = autoTrack.deviceInfo
      ? collectDeviceInfo({ appVersion: opts.appVersion ?? undefined })
      : opts.appVersion
        ? { appVersion: opts.appVersion }
        : {};

    this.state = {
      http,
      identity,
      entitlements,
      events,
      autoTracker: null,
      deviceInfo,
      options: opts,
      debug,
      developerUserId: null,
    };

    debug.emit("sdk.configured", `Crossdeck connected to ${opts.appId} in ${opts.environment} mode.`, {
      appId: opts.appId,
      environment: opts.environment,
      sdkVersion: opts.sdkVersion,
    });

    // Auto-tracker boots AFTER state is set so its initial track() calls
    // can resolve identity hints and device-info enrichment correctly.
    if (autoTrack.sessions || autoTrack.pageViews) {
      const tracker = new AutoTracker(autoTrack, (name, properties) =>
        this.track(name, properties),
      );
      this.state.autoTracker = tracker;
      tracker.install();
    }

    if (opts.autoHeartbeat) {
      // Fire-and-forget — heartbeat failure shouldn't block init().
      void this.heartbeat().catch(() => undefined);
    }
  }

  /**
   * @deprecated Use `init()` instead. NorthStar §4 standardised the
   * lifecycle method name across SDKs as `init` (formerly `start` /
   * `configure`). `start` will be removed in a future major version.
   */
  start(options: CrossdeckOptions): void {
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(
        "[crossdeck] Crossdeck.start() is deprecated — use Crossdeck.init() instead. The signature is the same.",
      );
    }
    this.init(options);
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
   * Subscribe to entitlement-cache changes. Returns an unsubscribe fn.
   *
   * The listener is invoked AFTER the cache mutates — once after a
   * successful `getEntitlements()` warms it, again after `syncPurchases()`
   * delivers fresh entitlements, and once on `reset()` to fire the
   * empty-cache state for logout flows.
   *
   * It is NOT invoked synchronously on subscribe. Callers that need
   * the current state should read it via `isEntitled()` / `listEntitlements()`
   * inline; the listener fires only on FUTURE changes.
   *
   * This is the foundation of the `useEntitlement` React hook in
   * `@cross-deck/web/react` — without it, React (or SwiftUI / Compose
   * / Vue) would have no way to re-render when entitlements arrive
   * asynchronously after init. The naive pattern of calling
   * `Crossdeck.isEntitled("pro")` directly inside a render path
   * shows the empty-cache result forever; binding the result to
   * component state via `onEntitlementsChange` is the correct
   * pattern.
   *
   * Idempotent unsubscribe — calling the returned function multiple
   * times is safe.
   *
   * Listener errors are swallowed (a buggy listener can't crash the
   * SDK or other listeners).
   */
  onEntitlementsChange(listener: EntitlementsListener): () => void {
    const s = this.requireStarted();
    return s.entitlements.subscribe(listener);
  }

  /**
   * Queue a telemetry event. Returns immediately — the network round-
   * trip happens in the background. To flush before the page unloads,
   * call flush().
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

    // NorthStar §15: warn (in debug mode) when a property name looks
    // dangerously like PII — email/password/token/secret/card/phone.
    // We don't strip the field; that's the developer's call. We just
    // surface the signal so they can spot accidental leaks early.
    if (s.debug.enabled && properties) {
      const flagged = findSensitivePropertyKeys(properties);
      if (flagged.length > 0) {
        s.debug.emit(
          "sdk.sensitive_property_warning",
          `Event "${name}" has potentially sensitive property names: ${flagged.join(", ")}. Crossdeck is privacy-first — avoid sending PII unless intentional.`,
          { eventName: name, flagged },
        );
      }
    }

    // §16 "No identity" — only emit once per session so a chatty client
    // doesn't spam the log with every track() before identify().
    if (s.debug.enabled && !s.developerUserId && !s.identity.crossdeckCustomerId) {
      s.debug.emit(
        "sdk.no_identity",
        "Using anonymous user until identify(userId) is called.",
      );
    }

    // Enrichment policy: device info first, then auto-tracker context (e.g.
    // sessionId on session events), then caller-supplied properties last so
    // a developer can override anything the SDK auto-attached.
    const enriched: EventProperties = { ...s.deviceInfo };
    const sessionId = s.autoTracker?.currentSessionId;
    if (sessionId) enriched.sessionId = sessionId;
    if (properties) Object.assign(enriched, properties);

    const event: QueuedEvent = {
      eventId: this.mintEventId(),
      name,
      timestamp: Date.now(),
      properties: enriched,
    };
    Object.assign(event, this.identityHintForEvent());
    s.events.enqueue(event);
  }

  /**
   * Force-flush queued events. Useful to call from page-unload handlers.
   *
   * NorthStar §4: standard method name across all Crossdeck SDKs.
   */
  async flush(): Promise<void> {
    const s = this.requireStarted();
    await s.events.flush();
  }

  /** @deprecated Use `flush()` instead. NorthStar §4 standardised the name. */
  async flushEvents(): Promise<void> {
    return this.flush();
  }

  /**
   * Forward purchase evidence to the backend for verification + entitlement
   * projection. NorthStar §4 + §13 canonical name.
   *
   * Today the web SDK only supports Apple StoreKit 2 forwarding (web apps
   * that sit alongside an iOS app). Stripe doesn't need this method —
   * Stripe webhooks deliver evidence server-side without a client round-trip.
   */
  async syncPurchases(input: {
    rail?: "apple";
    signedTransactionInfo: string;
    signedRenewalInfo?: string;
    appAccountToken?: string;
  }): Promise<PurchaseResult> {
    const s = this.requireStarted();
    if (!input.signedTransactionInfo) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_signed_transaction_info",
        message: "syncPurchases requires a signedTransactionInfo string from StoreKit 2.",
      });
    }
    const result = await s.http.request<PurchaseResult>("POST", "/purchases/sync", {
      body: { rail: input.rail ?? "apple", ...input },
    });
    s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    s.entitlements.setFromList(result.entitlements);
    s.debug.emit(
      "sdk.purchase_evidence_sent",
      "StoreKit transaction forwarded. Waiting for backend verification.",
      { rail: input.rail ?? "apple" },
    );
    return result;
  }

  /** @deprecated Use `syncPurchases()` instead. NorthStar §4 standardised the name. */
  async purchaseApple(input: {
    signedTransactionInfo: string;
    signedRenewalInfo?: string;
    appAccountToken?: string;
  }): Promise<PurchaseResult> {
    return this.syncPurchases({ rail: "apple", ...input });
  }

  /**
   * Toggle verbose diagnostic logging — NorthStar §16. When enabled, the
   * SDK emits a fixed vocabulary of debug signals to console.info that the
   * dashboard's onboarding checklist can also surface as live events.
   */
  setDebugMode(enabled: boolean): void {
    const s = this.requireStarted();
    s.debug.enabled = enabled;
    if (enabled) {
      s.debug.emit(
        "sdk.configured",
        `Debug mode enabled for ${s.options.appId} in ${s.options.environment} mode.`,
        { appId: s.options.appId, environment: s.options.environment },
      );
    }
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
    // Tear down + reinstall the auto-tracker so the new session belongs
    // to the new identity, not the old one.
    this.state.autoTracker?.uninstall();
    this.state.identity.reset();
    this.state.entitlements.clear();
    this.state.events.reset();
    this.state.developerUserId = null;
    if (this.state.autoTracker) {
      const tracker = new AutoTracker(this.state.options.autoTrack, (name, props) =>
        this.track(name, props),
      );
      this.state.autoTracker = tracker;
      tracker.install();
    }
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
        code: "not_initialized",
        message:
          "Call Crossdeck.init({ appId, publicKey, environment }) before any other method.",
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

/**
 * Normalise the autoTrack option to a fully-resolved AutoTrackConfig.
 *   undefined      → all defaults (everything on in browsers)
 *   true           → all on (same as defaults)
 *   false          → all off
 *   { sessions:false } → defaults for unspecified flags, override for specified ones
 */
/**
 * Derive the env from a publishable key prefix.
 *   cd_pub_test_… → "sandbox"
 *   cd_pub_live_… → "production"
 *   cd_pub_…       → null (legacy / unprefixed — env can't be inferred)
 *
 * We treat the legacy form as "no opinion" so the developer's explicit
 * `environment` declaration always wins for unprefixed keys (e.g. dev
 * fixture keys in tests).
 */
function inferEnvFromKey(publicKey: string): Environment | null {
  if (publicKey.startsWith("cd_pub_test_")) return "sandbox";
  if (publicKey.startsWith("cd_pub_live_")) return "production";
  return null;
}

function resolveAutoTrack(
  input: CrossdeckOptions["autoTrack"],
): AutoTrackConfig {
  if (input === false) {
    return { sessions: false, pageViews: false, deviceInfo: false };
  }
  if (input === undefined || input === true) {
    return { ...DEFAULT_AUTO_TRACK };
  }
  return {
    sessions: input.sessions ?? DEFAULT_AUTO_TRACK.sessions,
    pageViews: input.pageViews ?? DEFAULT_AUTO_TRACK.pageViews,
    deviceInfo: input.deviceInfo ?? DEFAULT_AUTO_TRACK.deviceInfo,
  };
}
