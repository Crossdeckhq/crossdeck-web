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
import { deriveIdempotencyKeyForPurchase } from "./idempotency-key";
import { EventQueue, type QueuedEvent } from "./event-queue";
import { PersistentEventStore } from "./event-storage";
import { CookieStorage, detectDefaultStorage, MemoryStorage } from "./storage";
import { randomChars } from "./identity";
import { collectDeviceInfo, type DeviceInfo } from "./device-info";
import { AutoTracker, DEFAULT_AUTO_TRACK, type AutoTrackConfig } from "./auto-track";
import { ConsoleDebugLogger, findSensitivePropertyKeys, type DebugLogger } from "./debug";
import { validateEventProperties } from "./event-validation";
import { SuperPropertyStore } from "./super-properties";
import {
  INTERNAL_OPT_OUT_PROPERTY,
  isInternalOptOut,
  processInternalOptOutUrl,
} from "./internal-opt-out";
import { WebVitalsTracker } from "./web-vitals";
import { ConsentManager, scrubPii, scrubPiiFromProperties, type ConsentState } from "./consent";
import { BreadcrumbBuffer, type Breadcrumb } from "./breadcrumbs";
import type { ContractFailureInput } from "./contracts";
import { sendDiagnosticTelemetry } from "./_diagnostic-telemetry";
import {
  STATIC_VERIFIERS,
  VerifierReporter,
  buildVerifierContext,
  buildFlushIntervalVerifier,
  defaultDebugModeFlag,
  runBootSelfTest,
  runOnErrorParse,
  runOnIdentify,
  runOnSyncPurchases,
  runOnTrack,
  type ContractVerifier,
  type VerifierContext,
} from "./_contract-verifiers";
import {
  DEFAULT_ERROR_CAPTURE,
  ErrorTracker,
  extractSelfHostname,
  type CapturedError,
  type ErrorCaptureConfig,
  type ErrorLevel,
} from "./error-capture";
import type {
  AliasResult,
  AutoTrackOptions,
  CrossdeckOptions,
  Diagnostics,
  EntitlementsListResponse,
  Environment,
  EventProperties,
  GroupTraits,
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
  webVitals: WebVitalsTracker | null;
  errors: ErrorTracker | null;
  breadcrumbs: BreadcrumbBuffer;
  errorContext: Record<string, unknown>;
  errorTags: Record<string, string>;
  errorBeforeSend: ((err: CapturedError) => CapturedError | null) | null;
  superProps: SuperPropertyStore;
  consent: ConsentManager;
  scrubPii: boolean;
  /** Cached enrichment payload merged into every event's properties. */
  deviceInfo: DeviceInfo;
  options: Required<
    Omit<
      CrossdeckOptions,
      | "storage"
      | "sdkVersion"
      | "autoTrack"
      | "appVersion"
      | "debug"
      | "respectDnt"
      | "scrubPii"
      // The three contract-verifier flags are resolved + consumed
      // outside state.options (see CrossdeckClient.verifierCtx /
      // verifierReporter / verifiers fields). They don't need to
      // round-trip through the InternalState options struct.
      | "verifyContractsAtBoot"
      | "logVerifierResults"
      | "disableContractAssertions"
    >
  > & {
    sdkVersion: string;
    autoTrack: AutoTrackConfig;
    appVersion: string | null;
  };
  debug: DebugLogger;
  developerUserId: string | null;
  /** Cleanup the unload-flush listeners installed in init(). */
  uninstallUnloadFlush: (() => void) | null;
  /** Most-recent server time observed via heartbeat (epoch ms). */
  lastServerTime: number | null;
  /** Local Date.now() captured at the same moment as lastServerTime. */
  lastClientTime: number | null;
}

export class CrossdeckClient {
  private state: InternalState | null = null;

  // ────────────────────────────────────────────────────────────────
  // Contract verifier layer (see sdks/web/src/_contract-verifiers.ts).
  //
  // Three flags govern this layer (CrossdeckOptions):
  //   verifyContractsAtBoot     — boot self-test on Crossdeck.start
  //   logVerifierResults        — print PASS results to console
  //   disableContractAssertions — total kill-switch
  //
  // When the kill-switch is set, all three fields stay null and
  // every hot-path dispatcher short-circuits — zero runtime cost.
  // Otherwise: populated once at init(), referenced from every
  // hot-path call site (identify, syncPurchases, ...).
  // ────────────────────────────────────────────────────────────────
  private verifiers: readonly ContractVerifier[] | null = null;
  private verifierReporter: VerifierReporter | null = null;
  private verifierCtx: VerifierContext | null = null;

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
    // Idempotent re-init: tear down listeners from any prior init()
    // before constructing the new state. Pre-fix
    // `state.uninstallUnloadFlush` was set but never invoked anywhere,
    // so calling init() a second time (config swap during dev,
    // multi-tenant SDK shell, hot-module-replacement) silently
    // accumulated duplicate `pagehide` / `beforeunload` /
    // `visibilitychange` listeners. Each one fired a redundant flush.
    // Audit P2: now teardown runs on every re-init.
    if (this.state) {
      try { this.state.uninstallUnloadFlush?.(); } catch { /* ignore */ }
      try { this.state.autoTracker?.uninstall(); } catch { /* ignore */ }
      try { this.state.webVitals?.uninstall(); } catch { /* ignore */ }
      try { this.state.errors?.uninstall(); } catch { /* ignore */ }
      // v1.4.0 Phase 5.5 — drain the prior EventQueue's pending
      // setTimeout BEFORE we replace this.state. Pre-fix the timer
      // would fire AFTER the state swap, firing against new
      // http/identity references with old-init events — a
      // cross-identity leak risk during HMR / config swap /
      // multi-tenant SDK shell. flush({keepalive:true}) cancels
      // the timer (see EventQueue.cancelTimerIfSet) and ships
      // queued events out under the prior init's identity.
      //
      // CRITICAL: do NOT clear the persistent event store here.
      // The durable queue belongs to the SDK lifetime, not the
      // init() lifetime — a survived crash mid-flush re-hydrates
      // on the next init.
      try { void this.state.events.flush({ keepalive: true }); } catch { /* ignore */ }
    }
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

    // Localhost auto-detection. When the SDK boots from localhost /
    // 127.0.0.1 / *.local / RFC1918 private IPs, automatically switch
    // to a fully-local "dev mode" — no network calls fire, all SDK
    // methods (track, identify, isEntitled) work against in-memory +
    // localStorage state only. The dev's live dashboard stays clean
    // even if they forgot to swap their cd_pub_live_* key for a
    // cd_pub_test_* one.
    //
    // Stripe-grade default. Confidence-first means we trust the dev's
    // key prefix in production; localhost is the one place where we
    // proactively prevent accidental pollution.
    const localDevMode = isLocalHostname();

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
      // 1500ms idle window. Short enough that an event queued on page
      // load still flushes if the user leaves quickly (the keepalive
      // pagehide handler picks up anything that doesn't); long enough
      // that bursts of clicks coalesce into one network round-trip.
      // v1.4.0 Phase 3.3 — flush interval default parity. Pre-
      // v1.4.0: Web/Node 1500ms, RN/Swift/Android 5000ms. All
      // converged on 2000ms (the Stripe-adjacent industry norm)
      // so cross-platform funnels show events landing at the
      // same cadence on every SDK. Per-instance override stays.
      eventFlushIntervalMs: options.eventFlushIntervalMs ?? 2000,
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
      // Localhost auto-route: HttpClient short-circuits every request
      // to a successful no-op response when localDevMode is set.
      // SDK methods continue to work locally; nothing reaches the
      // server.
      localDevMode,
      // Contract verifier hot-path hook — fires the `error-envelope-shape`
      // verifier on every parsed wire error, BEFORE the throw bubbles
      // back to user code. Centralised here so we don't need a try/catch
      // around every `await s.http.request(...)` call site downstream.
      // No-op when the verifier layer is disabled (verifiers === null).
      onErrorParsed: (err) => {
        if (this.verifiers && this.verifierReporter && this.verifierCtx) {
          runOnErrorParse(this.verifiers, this.verifierReporter, this.verifierCtx, {
            errorType: err.type,
            errorCode: err.code,
            requestId: err.requestId ?? null,
            httpStatus: typeof err.status === "number" ? err.status : 0,
          });
        }
      },
    });

    if (localDevMode) {
      // Single console line on first init — direct, not scolding.
      // Tells the dev exactly what's happening and how to change it.
      console.log(
        "[crossdeck] Localhost detected — running in dev mode (no network calls). " +
        "Set publicKey: 'cd_pub_test_…' and deploy to a real domain to test against the Crossdeck Sandbox.",
      );
    }
    // Bank-grade identity continuity (v0.6.0+). When persistIdentity is
    // on AND we're in a browser, the SDK writes the anonymousId to BOTH
    // localStorage (primary) and a 1st-party cookie (secondary). When
    // persistIdentity is off — typical during a strict-consent flow
    // before opt-in — we fall back to in-memory only and write nothing
    // to either store.
    //
    // The cookie is only constructed when the caller didn't override
    // `storage`; if a custom storage adapter was supplied, that wins
    // and the cookie redundancy is the caller's responsibility (they
    // chose a non-default store for a reason).
    const effectiveStorage = persistIdentity ? storage : new MemoryStorage();
    const useCookieRedundancy =
      persistIdentity &&
      !options.storage &&  // honour caller's adapter choice
      typeof (globalThis as { document?: unknown }).document !== "undefined";
    const cookieStore = useCookieRedundancy ? new CookieStorage() : undefined;
    const identity = new IdentityStore(effectiveStorage, opts.storagePrefix, cookieStore);
    // Durable last-known-good entitlement cache — persisted through the
    // same storage as identity so isEntitled() answers from device cache
    // on boot and rides out a Crossdeck outage instead of failing every
    // Pro customer to free. In-memory only when persistIdentity is off.
    const entitlements = new EntitlementCache(
      effectiveStorage,
      opts.storagePrefix + "entitlements",
    );
    // Durable persistence — write queued events through to the primary
    // identity store (typically localStorage) so a crash / hard close /
    // keepalive cap exceedance doesn't lose data. Skipped when
    // persistIdentity is off (strict consent / in-memory-only mode) —
    // no point writing events to a store the developer told us not to
    // use.
    const persistentEvents = persistIdentity
      ? new PersistentEventStore({ storage: effectiveStorage, prefix: opts.storagePrefix })
      : null;
    if (persistentEvents) {
      debug.emit(
        "sdk.queue_restored",
        "Restored persisted event queue from a prior session.",
      );
    }
    const events = new EventQueue({
      http,
      batchSize: opts.eventFlushBatchSize,
      intervalMs: opts.eventFlushIntervalMs,
      envelope: () => ({
        appId: opts.appId,
        environment: opts.environment,
        sdk: { name: SDK_NAME, version: opts.sdkVersion },
      }),
      persistentStore: persistentEvents ?? undefined,
      onFirstFlushSuccess: () => {
        debug.emit(
          "sdk.first_event_sent",
          "First telemetry event received. View it in Live Events.",
          { appId: opts.appId, environment: opts.environment },
        );
      },
      onRetryScheduled: (info) => {
        debug.emit(
          "sdk.flush_retry_scheduled",
          `Event flush failed (${info.lastError}). Retrying in ${info.delayMs}ms (attempt ${info.consecutiveFailures}).`,
          { ...info },
        );
      },
      onPermanentFailure: (info) => {
        // Bank-grade rule: a permanent 4xx that's dropping events MUST
        // be loud regardless of debug mode. Pre-fix the queue retried
        // 4xx forever silently and the customer never knew their key
        // was revoked. console.error fires unconditionally; the debug
        // signal lets the dashboard onboarding flow detect + surface
        // the problem too.
        const headline = `[crossdeck] Event batch DROPPED (status ${info.status}): ${info.lastError}. ${info.droppedCount} event(s) lost — check your publishable key + app config.`;
        // eslint-disable-next-line no-console
        console.error(headline);
        debug.emit(
          "sdk.flush_permanent_failure",
          headline,
          { ...info },
        );
      },
      onParked: (info) => {
        // Second signal channel (the queue already logged ONE console line).
        // PARK is NOT a drop: events are held on-device and resume on upgrade.
        // The dashboard reads this to render the calm amber "update to resume"
        // advisory. Distinct signal from flush_permanent_failure.
        debug.emit(
          "sdk.parked",
          `[crossdeck] SDK parked — server no longer accepts this version's event format. Events held on-device (paused, not lost); update @cross-deck/web${info.minVersion ? ` to >= ${info.minVersion}` : ""} to resume.`,
          { ...info },
        );
      },
    });

    // Collect device info ONCE at boot; cheap to re-use on every event.
    const deviceInfo: DeviceInfo = autoTrack.deviceInfo
      ? collectDeviceInfo({ appVersion: opts.appVersion ?? undefined })
      : opts.appVersion
        ? { appVersion: opts.appVersion }
        : {};

    // Super-property + groups store — Mixpanel pattern. Lives on the
    // primary identity storage so it survives page reloads but is
    // cleared on reset() / forget(). Skipped when persistIdentity is
    // off (strict consent — no writes anywhere).
    const superProps = new SuperPropertyStore(
      persistIdentity ? effectiveStorage : new MemoryStorage(),
      opts.storagePrefix,
    );

    // Internal-traffic opt-out: a ?crossdeck_internal=1/0 in the URL sets/
    // clears the persisted localStorage flag now; each event then reads it
    // (isInternalOptOut) to tag itself internal. Self-contained + guarded.
    processInternalOptOutUrl();

    // Consent gating. DNT auto-detection runs once here if respectDnt
    // is enabled; otherwise the developer is responsible for calling
    // Crossdeck.consent({...}) before user-meaningful events fire.
    const consent = new ConsentManager({ respectDnt: options.respectDnt === true });
    if (consent.isDntDenied) {
      debug.emit(
        "sdk.consent_dnt_applied",
        "Do Not Track detected — all tracking dimensions denied at init.",
      );
    }

    // Breadcrumb ring buffer — the "what was the user doing right
    // before things broke" feature. Populated by auto-tracking
    // sources (page views, clicks, custom events) and by manual
    // Crossdeck.addBreadcrumb() calls. Attached to every error
    // report; cleared on reset() / forget().
    const breadcrumbs = new BreadcrumbBuffer(50);

    this.state = {
      http,
      identity,
      entitlements,
      events,
      autoTracker: null,
      webVitals: null,
      errors: null,
      breadcrumbs,
      errorContext: {},
      errorTags: {},
      errorBeforeSend: null,
      superProps,
      consent,
      scrubPii: options.scrubPii !== false,
      deviceInfo,
      options: opts,
      debug,
      developerUserId: null,
      uninstallUnloadFlush: null,
      lastServerTime: null,
      lastClientTime: null,
    };

    debug.emit("sdk.configured", `Crossdeck connected to ${opts.appId} in ${opts.environment} mode.`, {
      appId: opts.appId,
      environment: opts.environment,
      sdkVersion: opts.sdkVersion,
    });

    // Auto-tracker boots AFTER state is set so its initial track() calls
    // can resolve identity hints and device-info enrichment correctly.
    if (autoTrack.sessions || autoTrack.pageViews) {
      const tracker = new AutoTracker(
        autoTrack,
        (name, properties) => this.track(name, properties),
        // Persist session continuity on the SAME adapter as identity, so
        // a visit survives full-page navigations (multi-page sites
        // re-install the SDK on every page) and honours the same consent
        // posture — MemoryStorage when identity persistence is off.
        { storage: effectiveStorage, storageKey: opts.storagePrefix + "session" },
      );
      this.state.autoTracker = tracker;
      tracker.install();
    }
    // Web Vitals tracker — emits LCP / INP / CLS / FCP / TTFB as named
    // events. No-op in non-browser environments or when the
    // PerformanceObserver primitive is missing.
    if (autoTrack.webVitals) {
      const vitals = new WebVitalsTracker(
        { enabled: true },
        (name, properties) => this.track(name, properties),
      );
      this.state.webVitals = vitals;
      vitals.install();
    }

    // ----- Error capture (the third pillar) -----
    // Installs global window.onerror + window.onunhandledrejection
    // handlers, wraps fetch + XHR, and reports each captured error
    // through the same event queue analytics uses. Crucially this
    // runs AFTER the queue, identity, and breadcrumb buffer are set
    // up — error events need all of them.
    if (autoTrack.errors) {
      const tracker = new ErrorTracker({
        config: { ...DEFAULT_ERROR_CAPTURE, enabled: true },
        breadcrumbs,
        report: (err) => this.reportError(err),
        getContext: () => ({ ...this.state!.errorContext }),
        getTags: () => ({ ...this.state!.errorTags }),
        // GETTER, not a captured value — `setErrorBeforeSend()` mutates
        // `state.errorBeforeSend` after init() and the tracker MUST
        // pick up the new hook on the next error. The pre-fix shape
        // (`beforeSend: this.state!.errorBeforeSend`) snapshotted
        // `null` at construction and made the customer's PII scrubber
        // silently inert. See error-capture.ts:ErrorTrackerOptions.beforeSend.
        beforeSend: () => this.state!.errorBeforeSend,
        isConsented: () => this.state!.consent.errors,
        // Derived from the configured baseUrl at init() time. Used by
        // the fetch / XHR wrappers to skip captureHttp on Crossdeck's
        // own requests — pre-fix the skip was hardcoded to
        // `api.cross-deck.com` and broke for customers on staging /
        // regional / self-hosted base URLs (recursive capture loop).
        selfHostname: extractSelfHostname(opts.baseUrl),
      });
      this.state.errors = tracker;
      tracker.install();
    }

    // Terminal flush wiring — without this, every page navigation drops
    // whatever's queued (page.viewed on load, session.ended on pagehide,
    // user clicks within the idle window). Use keepalive so the request
    // survives the unload. visibilitychange→hidden is the canonical
    // mobile signal (pagehide also fires there); pagehide + beforeunload
    // are the desktop ones. We listen to all three and rely on the
    // queue being a no-op when empty so a single trigger flushes once.
    this.state.uninstallUnloadFlush = installUnloadFlush(() => {
      // Fire-and-forget. Errors here can't be handled meaningfully — the
      // page is going away. Keepalive lets the browser keep the request
      // alive past unload up to 64 KB total in flight.
      void this.flush({ keepalive: true }).catch(() => undefined);
    });

    if (opts.autoHeartbeat && !localDevMode) {
      // Fire-and-forget — heartbeat failure shouldn't block init().
      // Skipped in dev mode — there's nothing to heartbeat.
      void this.heartbeat().catch(() => undefined);
    }

    // ────────────────────────────────────────────────────────────────
    // Contract verifier layer — install LAST so the SDK is fully
    // constructed before any verifier observes its state. See
    // sdks/web/src/_contract-verifiers.ts for the full architecture.
    //
    // Three-layer precedence (locked):
    //
    //   code option > dashboard remote config > DEBUG/RELEASE default
    //
    // Code wins so engineers retain ultimate control; the dashboard
    // toggle (per-app, via /dashboard/apps/{appId}) is the no-deploy
    // operational lever for QA / staging soaks; default is what ships
    // when nobody touches anything.
    //
    // Routing rules — locked here so a future change to init() can't
    // accidentally muddle them (the docstrings on the CrossdeckOptions
    // fields name each other as the wrong tool for the wrong job):
    //
    //   disableContractAssertions: true  → layer is entirely silent
    //   logVerifierResults:        false → console silent on PASS;
    //                                       FAIL still prints at WARN
    //   verifyContractsAtBoot:     false → no boot self-test, but
    //                                       hot-path verifiers still run
    //
    // `disableContractAssertions` is intentionally NOT remote-
    // configurable — sovereignty kill-switch must live in customer
    // source so procurement / audit teams can grep for it.
    // ────────────────────────────────────────────────────────────────
    if (options.disableContractAssertions !== true) {
      const debugDefault = defaultDebugModeFlag();
      // 1. SYNCHRONOUS BOOTSTRAP — context + reporter + verifier set
      //    are constructed immediately using code > default. Hot-path
      //    verifiers fire correctly from the next operation onwards.
      this.verifierCtx = buildVerifierContext({
        logVerifierResults: options.logVerifierResults ?? debugDefault,
        disableContractAssertions: false,
        // Best-effort run-context detection. Customers running the
        // Web SDK inside their own CI (Playwright, Cypress, etc.)
        // typically set CI=true; we use that as the signal. Otherwise
        // we assume `customer-app` — the SDK is running inside a
        // customer's deployed site.
        runContext: typeof process !== "undefined" && process.env && process.env.CI
          ? "ci"
          : "customer-app",
      });
      this.verifierReporter = new VerifierReporter(this.verifierCtx);
      const flushVerifier = buildFlushIntervalVerifier(opts.eventFlushIntervalMs);
      this.verifiers = Object.freeze([...STATIC_VERIFIERS, flushVerifier]);

      // 2. ASYNCHRONOUS REFINEMENT — fetch /v1/config and apply the
      //    dashboard's per-app remote config, then fire the boot
      //    self-test (so its output reflects the FINAL resolved
      //    flags, not the pre-fetch defaults). Fire-and-forget — a
      //    fetch failure leaves the local defaults in place and the
      //    boot self-test runs only if code > default resolves true.
      //
      //    Skipped in localDevMode (test harness / offline emulator
      //    where there's no backend to fetch from). Boot self-test
      //    still fires under code > default precedence directly.
      if (localDevMode) {
        const verifyAtBootLocal =
          options.verifyContractsAtBoot ?? debugDefault;
        if (verifyAtBootLocal && this.verifierReporter) {
          void runBootSelfTest(
            this.verifiers,
            this.verifierReporter,
            this.verifierCtx,
          ).catch(() => undefined);
        }
      } else {
        void this.bootstrapVerifierLayerRemote(options, debugDefault).catch(
          () => undefined,
        );
      }
    }
    // The previous synchronous boot-test block is now replaced by the
    // async refinement above. Closing brace below remains the end of
    // init().
    return;
  }

  /**
   * Fetch /v1/config from the backend and apply any per-app verifier
   * overrides set in the dashboard, then fire the boot self-test
   * once with the FINAL resolved flags.
   *
   * Precedence (also documented at the call site in init()):
   *   code option > dashboard remote config > DEBUG/RELEASE default
   *
   * Code wins so engineers retain ultimate control; dashboard is the
   * no-deploy operational lever for QA / staging soaks.
   *
   * Never throws — a /v1/config failure surfaces as "stick with the
   * synchronous defaults that init() already applied" and the boot
   * self-test runs only if code > default resolves true.
   */
  private async bootstrapVerifierLayerRemote(
    options: CrossdeckOptions,
    debugDefault: boolean,
  ): Promise<void> {
    if (!this.state || !this.verifiers || !this.verifierCtx) return;

    interface RemoteVerifierConfig {
      logVerifierResults: boolean | null;
      verifyContractsAtBoot: boolean | null;
    }
    interface ConfigResponseShape {
      verifierConfig?: RemoteVerifierConfig;
    }

    let remote: RemoteVerifierConfig = {
      logVerifierResults: null,
      verifyContractsAtBoot: null,
    };
    try {
      const resp = await this.state.http.request<ConfigResponseShape>(
        "GET",
        "/config",
      );
      if (resp && resp.verifierConfig) {
        const r = resp.verifierConfig;
        remote = {
          logVerifierResults:
            typeof r.logVerifierResults === "boolean"
              ? r.logVerifierResults
              : null,
          verifyContractsAtBoot:
            typeof r.verifyContractsAtBoot === "boolean"
              ? r.verifyContractsAtBoot
              : null,
        };
      }
    } catch {
      // Fall through — `remote` stays null, defaults apply.
    }

    // Resolve precedence: code > remote > default.
    const logResults =
      options.logVerifierResults ??
      (remote.logVerifierResults ?? debugDefault);
    const verifyAtBoot =
      options.verifyContractsAtBoot ??
      (remote.verifyContractsAtBoot ?? debugDefault);

    // If the remote config or precedence changed the resolved value
    // from what the synchronous bootstrap chose, rebuild the
    // context + reporter so subsequent hot-path verifiers see the
    // updated flags. The previous reporter is GC'd; in-flight hot-
    // path dispatches that snapshot the reporter (none currently;
    // every dispatcher reads `this.verifierReporter` at call time)
    // would see the old flags.
    if (logResults !== this.verifierCtx.logVerifierResults) {
      this.verifierCtx = {
        ...this.verifierCtx,
        logVerifierResults: logResults,
      };
      this.verifierReporter = new VerifierReporter(this.verifierCtx);
    }

    if (verifyAtBoot && this.verifierReporter) {
      await runBootSelfTest(
        this.verifiers,
        this.verifierReporter,
        this.verifierCtx,
      );
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
   *
   * v0.9.0+ accepts an optional `traits` bag — profile data (name,
   * plan, signupDate, role) persisted on the Crossdeck customer record
   * and queryable from dashboards. Traits are sanitised through the
   * same validator that gates `track()` properties, so a `{ avatar:
   * <File>, onSave: () => {} }` payload can't corrupt the alias call.
   *
   *   Crossdeck.identify("user_847", {
   *     email: "wes@pinet.co.za",
   *     traits: { name: "Wes", plan: "pro", signedUpAt: "2026-05-11" },
   *   });
   */
  async identify(userId: string, options?: IdentifyOptions): Promise<AliasResult> {
    const s = this.requireStarted();
    if (!userId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_user_id",
        message: "identify(userId) requires a non-empty userId.",
      });
    }
    if (!s.consent.analytics) {
      // No-op on consent denial — but throw NOT — the developer
      // expected an aliasResult to await. Return a no-op result that
      // mirrors the wire shape so existing call chains don't break.
      s.debug.emit(
        "sdk.consent_denied",
        `identify() skipped — consent denied for analytics.`,
      );
      return {
        object: "alias_result",
        crossdeckCustomerId: s.identity.crossdeckCustomerId ?? "",
        linked: [],
        mergePending: false,
        env: s.options.environment,
      };
    }
    // Sanitise traits at the SDK boundary so a malformed bag (function,
    // BigInt, circular) never crashes the alias request. Empty result
    // → omit the field entirely so backends that don't yet know about
    // traits aren't surprised by an unknown key.
    const traitsValidation =
      options?.traits !== undefined
        ? validateEventProperties(options.traits)
        : null;
    const traits = traitsValidation && Object.keys(traitsValidation.properties).length > 0
      ? traitsValidation.properties
      : undefined;
    if (s.debug.enabled && traitsValidation && traitsValidation.warnings.length > 0) {
      for (const w of traitsValidation.warnings) {
        s.debug.emit(
          "sdk.property_coerced",
          `identify() traits key ${JSON.stringify(w.key)} was ${w.kind.replace(/_/g, " ")} during validation.`,
          { key: w.key, kind: w.kind },
        );
      }
    }
    const body: Record<string, unknown> = {
      userId,
      anonymousId: s.identity.anonymousId,
    };
    if (options?.email) body.email = options.email;
    if (traits) body.traits = traits;

    // Bank-grade three-layer entitlement-cache isolation (v1.4.0
    // Phase 1.3). Switch the cache slot BEFORE the alias POST so a
    // mid-flight failure can't leave the cache pointing at the
    // prior user. setUserKey:
    //   (a) hashes the new userId into a physically separate
    //       storage suffix — `crossdeck:entitlements:<sha256>`,
    //   (b) unconditionally wipes the in-memory snapshot (no
    //       conditional gating — every identify() guarantees a
    //       fresh slot),
    //   (c) rehydrates from the new slot so a returning user sees
    //       their last-known-good immediately.
    // Capture prior userId BEFORE the slot rotation so the
    // per-user-cache-isolation verifier can observe the transition.
    // Reading this from `s.developerUserId` (the prior state) — the
    // assignment to the new value happens further down, after the
    // HTTP call.
    const priorUserId = s.developerUserId;

    s.entitlements.setUserKey(userId);

    // ────────────────────────────────────────────────────────────
    // Hot-path verifier: per-user-cache-isolation runs AFTER the
    // slot rotation completes. PASS prints to debug console if
    // `logVerifierResults: true`; FAIL prints at WARN + fires
    // `reportContractFailure(...)` to the reliability channel.
    // Short-circuits cheaply when `disableContractAssertions: true`.
    // ────────────────────────────────────────────────────────────
    if (this.verifiers && this.verifierReporter && this.verifierCtx) {
      runOnIdentify(this.verifiers, this.verifierReporter, this.verifierCtx, {
        priorUserId,
        nextUserId: userId,
        cache: s.entitlements,
      });
    }

    const result = await s.http.request<AliasResult>("POST", "/identity/alias", {
      body,
    });
    s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    s.developerUserId = userId;
    return result;
  }

  /**
   * Register super-properties — Mixpanel pattern. Once set, every
   * subsequent event of THIS SDK instance carries these keys on its
   * properties bag automatically.
   *
   *   Crossdeck.register({ plan: "pro", releaseChannel: "beta" });
   *   Crossdeck.track("paywall_shown");  // includes plan + releaseChannel
   *
   * Values that are `null` are deleted (the explicit "stop tracking
   * this key" idiom). Returns the resulting bag.
   *
   * Sanitised through `validateEventProperties` so a `{ avatar: File }`
   * payload can't poison the queue at flush time.
   */
  register(properties: Record<string, unknown>): Record<string, unknown> {
    const s = this.requireStarted();
    const validation = validateEventProperties(properties);
    return s.superProps.register(validation.properties);
  }

  /** Remove a single super-property key. Idempotent. */
  unregister(key: string): void {
    const s = this.requireStarted();
    s.superProps.unregister(key);
  }

  /** Snapshot of the current super-property bag. */
  getSuperProperties(): Record<string, unknown> {
    if (!this.state) return {};
    return this.state.superProps.getSuperProperties();
  }

  /**
   * Associate the current user with a group (org, team, account, etc.).
   * Mixpanel / Segment "Group Analytics" pattern.
   *
   *   Crossdeck.group("org", "acme_inc");
   *   Crossdeck.group("team", "design", { headcount: 12 });
   *
   * Once set, every subsequent event carries `$groups.<type>: id` on
   * its properties bag, enabling B2B dashboards ("how is Acme using
   * the product"). Pass `id: null` to clear a group membership.
   */
  group(type: string, id: string | null, traits?: GroupTraits): void {
    const s = this.requireStarted();
    if (!type) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_group_type",
        message: "group(type, id) requires a non-empty type.",
      });
    }
    const sanitisedTraits = traits ? validateEventProperties(traits).properties : undefined;
    s.superProps.setGroup(type, id, sanitisedTraits);
  }

  /** Snapshot of the current groups map keyed by type. */
  getGroups(): Record<string, { id: string; traits?: Record<string, unknown> }> {
    if (!this.state) return {};
    return this.state.superProps.getGroups();
  }

  /**
   * Update consent state. Three independent dimensions:
   *
   *   analytics  — track() + identify() + auto-emissions
   *   marketing  — paid-traffic click IDs + referrer URL on events
   *   errors     — Web Vitals + (future) error reporting
   *
   * Each defaults to `true` (granted). Pass partial state — only the
   * keys you provide are changed.
   *
   *   Crossdeck.consent({ analytics: false });
   *   Crossdeck.consent({ marketing: true, errors: true });
   *
   * DNT-derived denies cannot be flipped back on; if the browser said
   * "don't track" we don't track even if the developer code disagrees.
   */
  consent(state: Partial<ConsentState>): ConsentState {
    const s = this.requireStarted();
    const next = s.consent.set(state);
    s.debug.emit("sdk.consent_changed", "Consent state updated.", { ...next });
    return next;
  }

  /** Snapshot of the current consent state. */
  consentStatus(): ConsentState {
    if (!this.state) {
      return { analytics: true, marketing: true, errors: true };
    }
    return this.state.consent.get();
  }

  // ============================================================
  // Error capture surface (v1.0.0+)
  // ============================================================

  /**
   * Manually capture an error from a try/catch block.
   *
   *   try { …risky… } catch (err) {
   *     Crossdeck.captureError(err, { context: { plan: "pro" } });
   *   }
   *
   * The error is shipped through the same event queue as analytics
   * (durable, retried, rate-limited per fingerprint). Sends are gated
   * by `consent.errors`. Returns silently — never throws, even if the
   * SDK isn't initialised yet.
   */
  captureError(
    error: unknown,
    options?: { context?: Record<string, unknown>; tags?: Record<string, string>; level?: ErrorLevel },
  ): void {
    if (!this.state?.errors) return;
    this.state.errors.captureError(error, options);
  }

  /**
   * Capture a non-error event you want to surface as an issue
   * ("deprecated path hit", "we entered the slow code path"). Sentry
   * captureMessage pattern. Returns silently if not initialised.
   */
  captureMessage(message: string, level: ErrorLevel = "info"): void {
    if (!this.state?.errors) return;
    this.state.errors.captureMessage(message, level);
  }

  /**
   * Attach a tag to every subsequent error report. Tags are key/value
   * strings (Sentry pattern): `setTag("flow", "checkout")` → every
   * error from this point on carries `tags.flow === "checkout"`.
   */
  setTag(key: string, value: string): void {
    if (!this.state) return;
    this.state.errorTags[key] = value;
  }

  /** Bulk-set tags. Merges with existing tags. */
  setTags(tags: Record<string, string>): void {
    if (!this.state) return;
    Object.assign(this.state.errorTags, tags);
  }

  /**
   * Attach a structured context blob to every subsequent error report.
   * Unlike tags (flat key/value), context is a named bag of arbitrary
   * data: `setContext("cart", { items: 3, total: 42.99 })`.
   */
  setContext(name: string, data: Record<string, unknown>): void {
    if (!this.state) return;
    this.state.errorContext[name] = data;
  }

  /**
   * Add a custom breadcrumb to the rolling buffer. Useful for marking
   * domain-meaningful moments ("user opened paywall") that aren't
   * already auto-captured. The buffer caps at 50 entries; old ones
   * evict.
   */
  addBreadcrumb(crumb: Breadcrumb): void {
    if (!this.state) return;
    this.state.breadcrumbs.add(crumb);
  }

  /**
   * Install a pre-send hook for errors. Return null to drop, or a
   * modified CapturedError to scrub / rewrite. Sentry's beforeSend
   * pattern — the only way to redact app-specific PII (auth tokens
   * in URLs, etc.) before the report leaves the browser.
   */
  setErrorBeforeSend(
    hook: ((err: CapturedError) => CapturedError | null) | null,
  ): void {
    if (!this.state) return;
    this.state.errorBeforeSend = hook;
  }

  /**
   * Internal: turn a CapturedError into a Crossdeck event and enqueue
   * it. Goes through the same queue / persistence / consent / scrub
   * pipeline as analytics events.
   */
  private reportError(err: CapturedError): void {
    // Sanitise the error payload — stack frames may contain
    // user-supplied PII (emails / IDs in URLs). The scrub runs
    // automatically inside track() before the event lands in the
    // queue, but we also pre-flatten the structured fields here so
    // they're searchable in the warehouse.
    const properties: EventProperties = {
      // Identifiers
      fingerprint: err.fingerprint,
      level: err.level,
      // Error shape
      errorType: err.errorType,
      message: err.message,
      // Stack
      stack: err.rawStack ?? undefined,
      frames: err.frames,
      filename: err.filename ?? undefined,
      lineno: err.lineno ?? undefined,
      colno: err.colno ?? undefined,
      // Context
      tags: err.tags,
      context: err.context,
      breadcrumbs: err.breadcrumbs,
      // HTTP (only when applicable)
      http: err.http,
    };
    // Strip undefined values for a tidy wire shape.
    for (const k of Object.keys(properties)) {
      if (properties[k] === undefined) delete properties[k];
    }
    // Use track() for the full pipeline: validation, enrichment,
    // consent gate (gated on `analytics` though we already verified
    // `errors`), durable queue, retry, scrub. The event name follows
    // the namespacing convention so dashboards can filter `name
    // LIKE 'error.%'`.
    this.track(err.kind, properties);
  }

  /**
   * GDPR/CCPA "right to be forgotten" — calls the backend's
   * /v1/identity/forget endpoint to schedule a server-side deletion of
   * the customer's events and profile, then wipes all local state
   * (identity, entitlements, queue, super-props, persistent stores).
   *
   * Idempotent. Safe to call when no identity has been established
   * (it just wipes the empty local state).
   *
   * After forget() resolves, the SDK is in the same shape as if the
   * developer had called `Crossdeck.reset()` — a fresh anonymousId is
   * minted and the next session is a brand new identity-graph entry.
   */
  async forget(): Promise<void> {
    const s = this.requireStarted();
    const identityQuery = this.identityQueryParams();
    try {
      await s.http.request<{ object: "forgot" }>("POST", "/identity/forget", {
        body: {
          // Send every identity hint we hold; the server resolves the
          // canonical customer record and queues deletion. Missing
          // endpoint (older backend) gracefully degrades — local state
          // still wipes via the reset() call below.
          ...identityQuery,
        },
      });
    } catch (err) {
      // Server-side deletion failure is recorded but does not block
      // local wipe — the developer's user just asked to be forgotten,
      // refusing to clear their device because the backend hiccupped
      // would be the wrong call.
      s.debug.emit(
        "sdk.consent_denied",
        `forget() server call failed (${err instanceof Error ? err.message : String(err)}). Local state wiped anyway.`,
      );
    }
    this.reset();
  }

  /**
   * Read the current customer's active entitlements from the server.
   * Updates the local cache so subsequent isEntitled() calls answer
   * synchronously.
   */
  async getEntitlements(): Promise<PublicEntitlement[]> {
    const s = this.requireStarted();
    const query = this.identityQueryParams();
    let result: EntitlementsListResponse;
    try {
      result = await s.http.request<EntitlementsListResponse>(
        "GET",
        "/entitlements",
        { query }
      );
    } catch (err) {
      // The refresh failed (Crossdeck unreachable / transient error).
      // The durable cache keeps serving last-known-good — but mark it
      // stale so the staleness is visible via diagnostics(), never a
      // silent unbounded window. Then rethrow so the caller still sees
      // the failure.
      s.entitlements.markRefreshFailed();
      throw err;
    }
    if (result.crossdeckCustomerId) {
      s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    }
    s.entitlements.setFromList(result.data);
    return result.data;
  }

  /**
   * Synchronous read from the durable local cache — answers from
   * last-known-good. The cache hydrates from device storage on boot and
   * survives a Crossdeck outage, so a returning paying customer reads
   * true even before the session's first network round-trip. Returns
   * false only for a genuinely new install that has never completed a
   * getEntitlements(), or for an entitlement past its own validUntil.
   *
   * Throws `not_initialized` (CrossdeckError, type
   * `configuration_error`) if called before `Crossdeck.init()`. The
   * `useEntitlement` React hook and the Vue composable both swallow
   * this and return `false`; bare callers must guard for it (or call
   * after `init()` resolves).
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
   * delivers fresh entitlements, once on `reset()` to fire the empty-
   * cache state for logout flows, AND once on `identify()` after the
   * per-user cache slot rotates and re-hydrates from device storage.
   *
   * IMPORTANT — the `identify()` fire is a TRAP if you treat it as
   * authoritative network state. `identify()` does NOT fetch entitlements;
   * it switches the per-user cache slot and rehydrates from device
   * storage (which is empty for a brand-new install, and last-known-good
   * — possibly stale — for a returning user). A listener that gates a
   * paywall on the first fire after an identity switch will read
   * `false` for a paying customer on a fresh device and let them past
   * the gate as free. The network-truth fire is the one that follows
   * the next `getEntitlements()` resolution. Either call
   * `getEntitlements()` explicitly after `identify()`, or have your
   * gating code tolerate the empty-then-populated transition.
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
  /**
   * Emit `crossdeck.contract_failed` to the Crossdeck reliability
   * endpoint — single-fire, one-way, never visible in the customer's
   * dashboard. Goes over a dedicated HTTP path with the reliability
   * publishable key embedded at build time; the customer's track()
   * pipeline never carries `crossdeck.*` events. This is the
   * independent-controller flow described in Privacy Policy §6
   * ("Flow B"). The wire shape is fixed by the schema-lock contract
   * at `contracts/diagnostics/contract-failed-payload-schema-lock.json`.
   *
   * Wire the call from a test hook, dogfood failure path, or
   * customer contract-verification harness; see
   * `contracts/README.md` for the per-test-framework hook recipes.
   */
  reportContractFailure(input: ContractFailureInput): void {
    const payload: Record<string, string> = {
      contract_id: input.contractId,
      sdk_version: SDK_VERSION,
      sdk_platform: "web",
      failure_reason: input.failureReason,
      run_context: input.runContext,
      run_id: input.runId,
    };
    if (input.testRef) {
      payload.test_file = input.testRef.file;
      payload.test_name = input.testRef.name;
    }
    if (input.deviceClass) {
      payload.device_class = input.deviceClass;
    }
    sendDiagnosticTelemetry(payload);
  }

  track(name: string, properties?: EventProperties): void {
    const s = this.requireStarted();
    if (!name) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_name",
        message: "track(name) requires a non-empty name.",
      });
    }

    // ----- Consent gate -----
    // Three gates depending on event family:
    //   error.*   → consent.errors  (crashes, HTTP failures, captureMessage)
    //   webvitals.* → consent.errors (performance / reliability data)
    //   everything else → consent.analytics
    // Default-on; the developer must explicitly call
    // Crossdeck.consent({...:false}) to drop them.
    const isError = name.startsWith("error.");
    const isWebVital = name.startsWith("webvitals.");
    const consentGateOk = (isError || isWebVital) ? s.consent.errors : s.consent.analytics;
    if (!consentGateOk) {
      if (s.debug.enabled) {
        s.debug.emit(
          "sdk.consent_denied",
          `Dropped event "${name}" — consent denied for ${isWebVital ? "errors" : "analytics"}.`,
        );
      }
      return;
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

    // Validate + coerce caller-supplied properties BEFORE merging with
    // SDK enrichment. This is the boundary where untrusted developer
    // input becomes safe-to-serialise data: functions/symbols dropped,
    // Date / BigInt / Error coerced to JSON-friendly shapes, oversized
    // strings truncated, circular refs replaced. Without this, one bad
    // property (e.g. `{ onClick: () => {} }`) would crash JSON.stringify
    // at flush time and poison the entire batch indefinitely.
    //
    // The SDK's own enrichment (device info, sessionId, utm_*) is
    // trusted and not re-validated — those values are produced by
    // `collectDeviceInfo()` and `captureAcquisition()`, both of which
    // are typed and bounded.
    const validation = validateEventProperties(properties);
    if (s.debug.enabled && validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        s.debug.emit(
          "sdk.property_coerced",
          `Event "${name}" property ${JSON.stringify(w.key)} was ${w.kind.replace(/_/g, " ")} during validation.`,
          { eventName: name, key: w.key, kind: w.kind },
        );
      }
    }

    // Envelope v1 §3 — assign seq SYNCHRONOUSLY at track() time, before
    // markActivity() (which may roll a new session and reset the counter to
    // 0). The counter belongs to the session; capturing it here — at the
    // deterministic call-order instant — means seq ordering follows call
    // order, not scheduler luck. Also capture timestamp here so both fields
    // are one sample (spec §3 + Swift parity from fix commit 6ac71a1).
    const seq = s.autoTracker?.nextSeq() ?? 0;
    const occurrenceTimestamp = Date.now();

    // Enrichment policy: device info first, then auto-tracker context
    // (sessionId + per-session acquisition utm_*/referrer), then
    // caller-supplied properties last so a developer can override
    // anything the SDK auto-attached.
    //
    // Acquisition fields are session-scoped (captured once at session
    // start by AutoTracker) and attached to every event of that session
    // — that's the GA4 model: same source/medium/campaign labels every
    // event in the same visit. Empty strings are filtered out so we
    // don't pollute event property dictionaries with no-signal columns.
    // Enrichment layer order (later wins on key conflict):
    //   1. Session + pageview + acquisition + click IDs (auto-tracker)
    //   2. Super properties (registered once via Crossdeck.register)
    //   3. Group memberships (set via Crossdeck.group)
    //   4. Caller-supplied properties (sanitised)
    // Device facts (os, browser, locale, etc.) are promoted to the
    // top-level `context` object per Envelope v1 §4 and are NO LONGER
    // spread into `properties`. Screen dimensions and device pixel ratio
    // remain in `properties` as they are not part of the spec §4 context
    // schema and are not promoted.
    // The order is intentional: developer-supplied data is most
    // authoritative, so it overrides anything the SDK auto-attached.
    // Any tracked event — auto or custom — is activity: push the rolling
    // 30-min session window forward so a user who interacts via custom
    // events (not just pageviews/clicks) keeps one continuous session.
    s.autoTracker?.markActivity();

    // Envelope v1 §4 — build the standardized context object with the exact
    // spec field names. Promoted out of `properties`. Common fields: os,
    // osVersion, appVersion, sdkName, sdkVersion, locale, timezone. Web adds:
    // browser, browserVersion. Only include keys that are defined (string).
    const wireContext: Record<string, string> = {};
    const di = s.deviceInfo;
    if (di.os) wireContext.os = di.os;
    if (di.osVersion) wireContext.osVersion = di.osVersion;
    const appVer = s.options.appVersion;
    if (appVer) wireContext.appVersion = appVer;
    wireContext.sdkName = SDK_NAME;
    wireContext.sdkVersion = s.options.sdkVersion;
    if (di.locale) wireContext.locale = di.locale;
    if (di.timezone) wireContext.timezone = di.timezone;
    if (di.browser) wireContext.browser = di.browser;
    if (di.browserVersion) wireContext.browserVersion = di.browserVersion;

    // Properties layer: screen dimensions + pixel ratio remain in properties
    // (not promoted to context). Start WITHOUT deviceInfo spread — context
    // fields have been promoted out; only non-context device fields remain.
    const enriched: EventProperties = {};
    if (di.screenWidth !== undefined) enriched.screenWidth = di.screenWidth;
    if (di.screenHeight !== undefined) enriched.screenHeight = di.screenHeight;
    if (di.viewportWidth !== undefined) enriched.viewportWidth = di.viewportWidth;
    if (di.viewportHeight !== undefined) enriched.viewportHeight = di.viewportHeight;
    if (di.devicePixelRatio !== undefined) enriched.devicePixelRatio = di.devicePixelRatio;
    const sessionId = s.autoTracker?.currentSessionId;
    if (sessionId) enriched.sessionId = sessionId;
    const pageviewId = s.autoTracker?.currentPageviewId;
    if (pageviewId) enriched.pageviewId = pageviewId;
    const acquisition = s.autoTracker?.currentAcquisition;
    if (acquisition) {
      // UTMs and referrer host are always attached (they're considered
      // analytics, not marketing PII). Paid-traffic click IDs and the
      // full referrer URL gate on marketing consent — the developer's
      // user said "no marketing tracking" → drop them.
      if (acquisition.utm_source) enriched.utm_source = acquisition.utm_source;
      if (acquisition.utm_medium) enriched.utm_medium = acquisition.utm_medium;
      if (acquisition.utm_campaign) enriched.utm_campaign = acquisition.utm_campaign;
      if (acquisition.utm_content) enriched.utm_content = acquisition.utm_content;
      if (acquisition.utm_term) enriched.utm_term = acquisition.utm_term;
      if (acquisition.referrer && s.consent.marketing) enriched.referrer = acquisition.referrer;
      if (s.consent.marketing) {
        if (acquisition.gclid) enriched.gclid = acquisition.gclid;
        if (acquisition.fbclid) enriched.fbclid = acquisition.fbclid;
        if (acquisition.msclkid) enriched.msclkid = acquisition.msclkid;
        if (acquisition.ttclid) enriched.ttclid = acquisition.ttclid;
        if (acquisition.li_fat_id) enriched.li_fat_id = acquisition.li_fat_id;
        if (acquisition.twclid) enriched.twclid = acquisition.twclid;
      }
    }
    // Super properties registered via Crossdeck.register(). Skipped
    // for keys the auto-enrichment already supplied so a `register`
    // call can't accidentally shadow `sessionId` etc.
    const supers = s.superProps.getSuperProperties();
    for (const k of Object.keys(supers)) {
      if (!(k in enriched)) enriched[k] = supers[k];
    }
    // Group memberships — attached as `$groups.<type>` for B2B
    // dashboards. Mixpanel uses `$groups`; we mirror exactly so
    // existing integrators don't need a translation layer.
    const groupIds = s.superProps.getGroupIds();
    if (Object.keys(groupIds).length > 0) {
      enriched.$groups = groupIds;
    }
    Object.assign(enriched, validation.properties);

    // Internal-traffic opt-out: this browser visited ?crossdeck_internal=1,
    // so tag every event for ingest to classify as internal. Injected after
    // developer properties so it can't be shadowed; reserved $-prefixed key.
    if (isInternalOptOut()) {
      enriched[INTERNAL_OPT_OUT_PROPERTY] = true;
    }

    // ----- PII scrub -----
    // Last step before the event lands in the queue: defensive regex
    // scrub on URL paths, titles, and any string property value. An
    // app that puts emails or card numbers in URLs (`/users/wes@…/`)
    // would otherwise ship that PII straight to the warehouse. Even
    // with explicit consent this is the right default — Stripe scrubs
    // pre-storage too. Disable via `scrubPii: false` in init() for
    // pipelines that do their own redaction.
    const finalProperties = s.scrubPii ? scrubPiiFromProperties(enriched) : enriched;

    const event: QueuedEvent = {
      eventId: this.mintEventId(),
      name,
      timestamp: occurrenceTimestamp,
      seq,
      context: wireContext,
      properties: finalProperties,
    };
    Object.assign(event, this.identityHintForEvent());
    s.events.enqueue(event);

    // ────────────────────────────────────────────────────────────────
    // Hot-path verifier: `super-property-merge-precedence` runs AFTER
    // enqueue so the merged properties reflect EXACTLY what the queue
    // accepted. The observation carries the three input layers
    // separately + the merged result so the verifier can prove
    // caller > super > device precedence on every real track() call,
    // not just at boot. PASS prints to debug console iff
    // `logVerifierResults: true`; FAIL prints at WARN + fires
    // `reportContractFailure(...)` to the reliability channel.
    // Cheap short-circuit when `disableContractAssertions: true`.
    //
    // mergedProperties is observed PRE-SCRUB (`enriched`), not POST-
    // SCRUB (`finalProperties`). The contract enforced here is
    // "device < super < caller" — i.e., which LAYER's value wins per
    // key. PII scrub runs AFTER merge and intentionally mutates
    // strings (redacts emails, IPs, card numbers) and re-clones
    // arrays + plain objects. Strict-equal vs `finalProperties`
    // therefore produces false positives on any caller-supplied
    // compound value: `caller.frames === finalProperties.frames` is
    // `false` because scrub's `Array.map` returns a fresh array, even
    // when contents are unchanged. Founder caught this on
    // 2026-05-28 — a real `crossdeck.error` track() carrying
    // `frames: [...]` fired the hot-path FAIL on
    // `super-property-merge-precedence`, masking real bugs in the
    // dashboard. Scrub correctness is verified separately; this
    // verifier's job is solely merge-layer precedence.
    // ────────────────────────────────────────────────────────────────
    if (this.verifiers && this.verifierReporter && this.verifierCtx) {
      // Cast the four input layers to the verifier's open
      // Record<string, unknown> view. DeviceInfo / EventProperties are
      // narrowed-string-key records at runtime; the verifier only
      // reads keys/values, never writes, so the widen is sound. Done
      // here, not in the verifier signature, so the SDK call site
      // keeps the strictly-typed source values for refactors.
      runOnTrack(this.verifiers, this.verifierReporter, this.verifierCtx, {
        callerProperties: validation.properties as Record<string, unknown>,
        superProperties: supers as Record<string, unknown>,
        deviceProperties: s.deviceInfo as unknown as Record<string, unknown>,
        mergedProperties: enriched as Record<string, unknown>,
      });
    }

    // ----- Breadcrumb emission -----
    // Every analytics event becomes a breadcrumb so error reports
    // carry the context of what the user was doing just before the
    // crash. Don't emit a breadcrumb for error events themselves
    // (would be circular) or webvitals events (noise — they always
    // fire on every page).
    if (!isError && !isWebVital) {
      const category = name.startsWith("page.")
        ? "navigation"
        : name.startsWith("element.") || name === "session.started"
          ? "ui.click"
          : "custom";
      s.breadcrumbs.add({
        timestamp: event.timestamp,
        category,
        message: name,
        // Strip the device-info / session bloat from the breadcrumb
        // payload — only the caller-supplied properties belong in
        // the user-readable trail.
        data: properties ? { ...properties } : undefined,
      });
    }
  }

  /**
   * Force-flush queued events. Useful to call from page-unload handlers.
   *
   * Pass `{ keepalive: true }` from terminal handlers (pagehide /
   * visibilitychange→hidden / beforeunload). The browser keeps the
   * request alive after the page tears down, so the final batch
   * actually lands instead of being cancelled with the unload.
   *
   * NorthStar §4: standard method name across all Crossdeck SDKs.
   */
  async flush(options: { keepalive?: boolean } = {}): Promise<void> {
    const s = this.requireStarted();
    await s.events.flush(options);
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
    // Spread input FIRST so the explicit `rail` default below WINS.
    // Pre-fix order was `{ rail: input.rail ?? "apple", ...input }`
    // — but `...input` runs LAST and overrides the default with the
    // caller's literal `rail` key, including the case where the
    // caller passes `rail: undefined` explicitly (TypeScript treats
    // an undefined-typed property as "key present"). Reversing the
    // order so the default sits last fixes both the explicit-undefined
    // case AND the omitted-key case in one line.
    const rail = input.rail ?? "apple";
    const body = { ...input, rail };
    // Phase 2.2 bank-grade contract: deterministic Idempotency-Key
    // from the body. Same input → same key → backend short-
    // circuits with idempotent_replay: true on retry.
    const idempotencyKey = deriveIdempotencyKeyForPurchase(body);

    // ────────────────────────────────────────────────────────────
    // Hot-path verifier: idempotency-key-deterministic re-derives the
    // key from the same input and compares against what the SDK
    // computed. Identical → contract honoured. Drift → bug.
    // ────────────────────────────────────────────────────────────
    if (this.verifiers && this.verifierReporter && this.verifierCtx) {
      const stableId =
        rail === "apple"
          ? (body as { signedTransactionInfo?: string }).signedTransactionInfo ?? ""
          : (body as { purchaseToken?: string }).purchaseToken ?? "";
      runOnSyncPurchases(
        this.verifiers,
        this.verifierReporter,
        this.verifierCtx,
        {
          rail,
          stableIdentifier: stableId,
          derivedKey: idempotencyKey,
        },
      );
    }

    const result = await s.http.request<PurchaseResult>("POST", "/purchases/sync", {
      body,
      idempotencyKey,
    });
    s.identity.setCrossdeckCustomerId(result.crossdeckCustomerId);
    s.entitlements.setFromList(result.entitlements);
    // Phase 3.5 (v1.4.0) — emit purchase.completed so manual
    // syncPurchases callers show up on the same funnel as the
    // Swift/Android auto-track path. Schema mirrors the native
    // auto-track shape so cross-platform funnels reconcile on
    // event name + the rail/productId fields. Manual paths don't
    // see the StoreKit Transaction so transactionId/purchaseDate
    // are absent — funnel queries that need them stay native-
    // auto-track only.
    try {
      const sourceProductId = result.entitlements[0]?.source.productId;
      const sourceSubscriptionId = result.entitlements[0]?.source.subscriptionId;
      const props: Record<string, unknown> = { rail };
      if (sourceProductId) props.productId = sourceProductId;
      if (sourceSubscriptionId) props.subscriptionId = sourceSubscriptionId;
      if (result.idempotent_replay) props.idempotent_replay = true;
      this.track("purchase.completed", props);
    } catch {
      // track() throws only on invalid name (we control it) — defensive.
    }
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
    const result = await s.http.request<HeartbeatResponse>("GET", "/sdk/heartbeat");
    // Capture clock skew at the SAME instant on both sides. The
    // `serverTime` field is the only authoritative source the SDK has
    // for "what does the backend think the time is" — used in
    // diagnostics() so a wrong-system-clock problem surfaces before
    // it silently shifts a day of analytics.
    if (typeof result?.serverTime === "number" && Number.isFinite(result.serverTime)) {
      s.lastServerTime = result.serverTime;
      s.lastClientTime = Date.now();
    }
    return result;
  }

  /**
   * Wipe persisted identity + entitlement cache. Use on logout. The
   * next pre-login session generates a fresh anonymousId and starts a
   * new identity-graph entry.
   */
  reset(): void {
    if (!this.state) return;
    // Server-derived milestone: emit `user.signed_out` BEFORE we wipe
    // identity. The track() call enqueues the event with the current
    // developerUserId/cdcust stamped on it; the subsequent reset of
    // the identity store happens locally only — the queued event
    // already left with the right identity. The dashboard's Activity
    // stream therefore shows "Wes signed out" rather than an
    // anonymous orphan event. Skipped if there's no developerUserId
    // (calling reset on a never-identified anonymous device is a no-op
    // semantically — there was nothing to "sign out" of).
    if (this.state.developerUserId) {
      try {
        this.track("user.signed_out", { auto: true });
      } catch {
        // track() throws only on invalid name — never for a literal we control.
        // Defensive catch keeps reset() bulletproof for logout flows.
      }
    }
    // Tear down + reinstall the auto-tracker so the new session belongs
    // to the new identity, not the old one. Unload-flush listeners stay
    // installed across reset — they're tied to the SDK lifetime, not
    // the identity lifetime. Web Vitals stay attached too — their
    // observers are per-page-life, not per-identity.
    this.state.autoTracker?.uninstall();
    this.state.identity.reset();
    // Logout-grade wipe: removes EVERY per-user entitlement slot on
    // this device (layer (c) of the v1.4.0 isolation fix). A shared
    // device can never leave another user's entitlements readable
    // after a logout.
    this.state.entitlements.clearAll();
    this.state.events.reset();
    // Super properties + groups are identity-scoped — clear on logout
    // so a fresh anonymous session doesn't inherit the previous user's
    // plan/role/group context.
    this.state.superProps.clear();
    // Breadcrumbs + error context belong to the old session; wipe so
    // a fresh post-logout error report doesn't carry the previous
    // user's debugging trail. The ErrorTracker stays installed across
    // reset — its listeners are page-life-scoped, not identity-scoped.
    this.state.breadcrumbs.clear();
    this.state.errorContext = {};
    this.state.errorTags = {};
    this.state.developerUserId = null;
    // Null clock-skew snapshot on reset — these values belong to the
    // pre-logout session. Pre-fix `diagnostics().clock.skewMs` for the
    // next user kept reporting the prior session's skew until the
    // next heartbeat completed (audit P1 #17). The next heartbeat
    // repopulates with the new instant.
    this.state.lastServerTime = null;
    this.state.lastClientTime = null;
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
        clock: { lastServerTime: null, lastClientTime: null, skewMs: null },
        entitlements: { count: 0, lastUpdated: 0, stale: false, listenerErrors: 0 },
        events: {
          buffered: 0,
          dropped: 0,
          inFlight: 0,
          lastFlushAt: 0,
          lastError: null,
          consecutiveFailures: 0,
          nextRetryAt: null,
        },
      };
    }
    const s = this.state;
    const skewMs =
      s.lastServerTime !== null && s.lastClientTime !== null
        ? s.lastClientTime - s.lastServerTime
        : null;
    return {
      started: true,
      anonymousId: s.identity.anonymousId,
      crossdeckCustomerId: s.identity.crossdeckCustomerId,
      developerUserId: s.developerUserId,
      sdkVersion: s.options.sdkVersion,
      baseUrl: s.options.baseUrl,
      clock: {
        lastServerTime: s.lastServerTime,
        lastClientTime: s.lastClientTime,
        skewMs,
      },
      entitlements: {
        count: s.entitlements.list().length,
        lastUpdated: s.entitlements.freshness,
        stale: s.entitlements.isStale,
        listenerErrors: s.entitlements.listenerErrors,
      },
      events: s.events.getStats(),
    };
  }

  /**
   * The stable reference to hand Stripe at checkout so the resulting
   * purchase attributes to THIS person. Stamp it on the Checkout Session
   * as `metadata.crossdeck_ref` (see docs/connect-stripe) — the platform
   * webhook reads it back, validates it, and attaches the subscription to
   * the right customer instead of stranding it on an anonymous record.
   *
   * Returns the strongest identifier the SDK currently holds, in the same
   * precedence the server resolves by:
   *   crossdeckCustomerId (cdcust_…) > developerUserId > anonymousId
   * anonymousId is always present, so this always returns a usable,
   * non-empty reference — even before identify(). Identify the user as
   * early as you can, though, so the reference is their stable identity
   * and not a per-device anon id.
   */
  getCheckoutReference(): string {
    const s = this.requireStarted();
    return (
      s.identity.crossdeckCustomerId ??
      s.developerUserId ??
      s.identity.anonymousId
    );
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

  /**
   * Embed every known identity axis on the event. Earlier this returned
   * just the highest-priority hint (cdcust → developerUserId → anonymousId)
   * to keep payloads small, but that leaked into analytics: once a user
   * was logged in, every subsequent page.viewed shipped without
   * anonymousId, and `uniqExact(anonymous_id)` on the warehouse side
   * counted 0 visitors for the entire authenticated app.
   *
   * Bank-grade rule: the server is the single source of truth on
   * dedup. Send everything we know; let CH count by whichever axis
   * matches the question. Each field is at most 32 bytes — sending
   * three on every event costs ~80 bytes per request, which is
   * trivial compared to the analytics correctness it buys.
   */
  private identityHintForEvent(): Pick<
    QueuedEvent,
    "developerUserId" | "anonymousId" | "crossdeckCustomerId"
  > {
    const s = this.requireStarted();
    const hint: Pick<QueuedEvent, "developerUserId" | "anonymousId" | "crossdeckCustomerId"> = {
      anonymousId: s.identity.anonymousId,
    };
    if (s.developerUserId) hint.developerUserId = s.developerUserId;
    if (s.identity.crossdeckCustomerId) {
      hint.crossdeckCustomerId = s.identity.crossdeckCustomerId;
    }
    return hint;
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

/**
 * Detect whether the SDK is booting on a local-development hostname.
 * Triggers the SDK's silent dev-mode shutoff (no network calls, all
 * state local) so a developer running their app locally with a live
 * key cannot accidentally pollute their production analytics.
 *
 * Match list:
 *   - localhost / 127.0.0.1     traditional local dev
 *   - *.local                   mDNS / Bonjour (e.g. mymac.local)
 *   - 10.x.x.x                  RFC1918 class A (private)
 *   - 192.168.x.x               RFC1918 class C (home / office LAN)
 *   - 172.16-31.x.x             RFC1918 class B
 *
 * Vercel preview URLs, Netlify branch deploys, ngrok tunnels — those
 * resolve to real domains and stay on whatever the key says. They're
 * not "local," they're "deployed under a temporary domain."
 *
 * Returns false in non-browser contexts (Node, Workers) — there's no
 * window.location to inspect, and a Node consumer that wired up the
 * SDK is presumably running server-side with a deliberate config.
 */
function isLocalHostname(): boolean {
  // Testing escape hatch — E2E suites + smoke pages need to exercise
  // the real wire shape from a non-deployed domain (Playwright runs
  // on 127.0.0.1). Setting `window.__CROSSDECK_FORCE_LIVE__ = true`
  // before init() returns false here so the SDK fires real fetches.
  // Not documented in SDK_TRUTH because it's internal-only — real
  // consumers should never set this.
  const w = (globalThis as {
    window?: { location?: { hostname?: string }; __CROSSDECK_FORCE_LIVE__?: boolean };
  }).window;
  if (w?.__CROSSDECK_FORCE_LIVE__ === true) return false;
  const hostname = w?.location?.hostname;
  if (!hostname) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  // 0.0.0.0 is the default bind address for webpack-dev-server /
  // vite dev server when the team is on a shared LAN dev. Audit P2:
  // pre-fix this slipped through and polluted live analytics for
  // anyone running those configs.
  if (hostname === "0.0.0.0") return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  // IPv6 link-local: fe80::/10. Devices on the same network segment
  // (browser inspector debugging an iPad via Safari Web Inspector
  // over USB lands here). Conservative match — only the link-local
  // prefix, not the broader ULA fc00::/7 range which is intended for
  // private routed networks and shouldn't auto-quiet by default.
  if (/^\[?fe80::/i.test(hostname)) return true;
  if (hostname.endsWith(".local")) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;
  return false;
}

function resolveAutoTrack(
  input: CrossdeckOptions["autoTrack"],
): AutoTrackConfig {
  if (input === false) {
    return {
      sessions: false,
      pageViews: false,
      deviceInfo: false,
      clicks: false,
      webVitals: false,
      errors: false,
    };
  }
  if (input === undefined || input === true) {
    return { ...DEFAULT_AUTO_TRACK };
  }
  return {
    sessions: input.sessions ?? DEFAULT_AUTO_TRACK.sessions,
    pageViews: input.pageViews ?? DEFAULT_AUTO_TRACK.pageViews,
    deviceInfo: input.deviceInfo ?? DEFAULT_AUTO_TRACK.deviceInfo,
    clicks: input.clicks ?? DEFAULT_AUTO_TRACK.clicks,
    webVitals: input.webVitals ?? DEFAULT_AUTO_TRACK.webVitals,
    errors: input.errors ?? DEFAULT_AUTO_TRACK.errors,
  };
}

/**
 * Install browser unload listeners that fire `onUnload` when the page
 * is going away. We listen to all three because each browser/platform
 * is unreliable on at least one of them:
 *   - `pagehide` is the modern, mobile-reliable signal (Safari iOS only
 *     fires this — beforeunload doesn't fire on backgrounding there).
 *   - `visibilitychange → hidden` is the canonical "tab going to bg"
 *     signal; bfcache restores re-fire `pagehide`/`pageshow`.
 *   - `beforeunload` is the legacy desktop signal — kept as a belt for
 *     older Chrome/Firefox versions.
 *
 * The handler is idempotent: if the queue is empty, flush() is a no-op,
 * so multiple firings during one unload are harmless.
 *
 * Returns a teardown that removes all three listeners. No-ops in non-
 * browser environments (Node, Web Workers).
 */
function installUnloadFlush(onUnload: () => void): () => void {
  const w = (globalThis as { window?: Window }).window;
  const doc = (globalThis as { document?: Document }).document;
  if (!w || !doc) return () => undefined;

  const onVisChange = (): void => {
    if (doc.visibilityState === "hidden") onUnload();
  };
  const onTerminal = (): void => onUnload();

  doc.addEventListener("visibilitychange", onVisChange);
  w.addEventListener("pagehide", onTerminal);
  w.addEventListener("beforeunload", onTerminal);

  return () => {
    doc.removeEventListener("visibilitychange", onVisChange);
    w.removeEventListener("pagehide", onTerminal);
    w.removeEventListener("beforeunload", onTerminal);
  };
}
