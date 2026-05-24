/**
 * HTTP transport for the SDK. Single fetch wrapper used by every endpoint
 * call. Adds the Bearer token and SDK version header, parses responses,
 * normalises errors to CrossdeckError.
 *
 * Uses platform-native fetch (browser + Node 18+). No axios, no isomorphic-
 * fetch shim, no transitive deps.
 */

import { CrossdeckError, crossdeckErrorFromResponse } from "./errors";
// Single source of truth — version comes from package.json so a `npm
// version` bump is the ONLY place a release-engineer touches. Every
// downstream surface (Crossdeck-Sdk-Version header, docs, dashboard
// snippets) reads from here at build time (SDK) or via
// scripts/sync-sdk-versions.mjs (static docs). Pre-fix this was a
// hardcoded literal that drifted from package.json — the published
// 1.2.0 bundle reported `Crossdeck-Sdk-Version: @cross-deck/web@1.1.0`
// on the wire because nobody bumped the constant.
import { version as PACKAGE_VERSION } from "../package.json";

export const SDK_NAME = "@cross-deck/web";
export const SDK_VERSION = PACKAGE_VERSION;
export const DEFAULT_BASE_URL = "https://api.cross-deck.com/v1";

export interface HttpClientConfig {
  publicKey: string;
  baseUrl: string;
  sdkVersion: string;
  /**
   * Localhost auto-detection short-circuit. When true, every request
   * resolves to a fabricated 2xx-shaped response — no network call
   * goes out. Set by Crossdeck.init() when the SDK boots on a local
   * dev hostname. Confidence-first design: we never let a developer's
   * laptop pollute their live analytics by accident.
   */
  localDevMode?: boolean;
  /**
   * Default request timeout in ms. Per-call `options.timeoutMs` overrides.
   * Caller's `options.timeoutMs: 0` disables the timeout entirely (useful
   * for tests that intentionally hang).
   *
   * Stripe-grade default: 15s. Long enough that a slow-3G mobile keeps
   * the request alive; short enough that a captive portal or a hung
   * connection doesn't sit forever. Without this, fetch() inherits the
   * browser's default (which on Chrome can be 5+ minutes) and a single
   * bad network can lock up the entire event queue.
   */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpRequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  /**
   * Mark the request as `keepalive` so the browser keeps it in flight
   * even after the page begins unloading. Critical for terminal flushes
   * fired from `pagehide` / `visibilitychange` — without this, the queued
   * page.viewed / session.ended events get cancelled the moment the user
   * navigates away.
   *
   * Spec: https://developer.mozilla.org/docs/Web/API/Fetch_API/Using_Fetch#sending_a_request_with_keepalive
   * Body cap: 64 KB total across all keepalive requests in flight.
   */
  keepalive?: boolean;
  /**
   * Per-request timeout override (ms). Defaults to the client's
   * `timeoutMs` (15s). Pass 0 to disable the timeout entirely — only
   * sensible for tests or long-poll endpoints we don't have today.
   */
  timeoutMs?: number;
  /**
   * Stripe-style idempotency key. When set, the SDK adds
   * `Idempotency-Key: <value>` to the request. Reuses the SAME key
   * across retries of the SAME logical operation so the server can
   * short-circuit duplicate work without per-event dedup.
   *
   * The SDK supplies this for every batch flush — see `event-queue.ts`.
   * Callers can pass it for ad-hoc retried POSTs too.
   */
  idempotencyKey?: string;
}

export class HttpClient {
  constructor(private readonly config: HttpClientConfig) {}

  /**
   * Issue a request. `path` is relative to the configured baseUrl
   * ("/entitlements", "/identity/alias", etc.).
   *
   * Throws CrossdeckError on:
   *   - Network failure (`type: "network_error"`)
   *   - Non-2xx response (typed from the body envelope)
   *   - JSON parse failure on a 2xx (treated as `internal_error`)
   */
  async request<T>(
    method: "GET" | "POST",
    path: string,
    options: HttpRequestOptions = {}
  ): Promise<T> {
    // Localhost short-circuit. Every request returns a synthetic
    // success shape so the SDK methods that depend on a response
    // (heartbeat, alias, getEntitlements) don't break — but no
    // packet leaves the browser. The shape is path-aware so common
    // callers get sensible empties.
    if (this.config.localDevMode) {
      return synthesizeLocalDevResponse<T>(path);
    }

    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.publicKey}`,
      "Crossdeck-Sdk-Version": `${SDK_NAME}@${this.config.sdkVersion}`,
      Accept: "application/json",
    };
    if (options.idempotencyKey) {
      // Stripe pattern: same key on retries → server can short-circuit
      // duplicate work without inspecting the body.
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    let bodyInit: BodyInit | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(options.body);
    }

    // ----- Abort timeout -----
    // Wire up an AbortController so a stuck connection (captive portal,
    // satellite link, DNS hang) doesn't lock the queue forever. Per-call
    // `timeoutMs: 0` disables, otherwise fall back to client default
    // (15s). The controller is scoped to this request only — clearing
    // the timer in finally prevents a stale abort from firing after we
    // already got a response. `AbortSignal.timeout(ms)` would be cleaner
    // but isn't supported in Safari < 16.4; this hand-rolled pattern is
    // portable to every browser fetch() supports.
    const effectiveTimeout = options.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller =
      typeof AbortController !== "undefined" && effectiveTimeout > 0
        ? new AbortController()
        : null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (controller && effectiveTimeout > 0) {
      timeoutHandle = setTimeout(() => controller.abort(), effectiveTimeout);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        keepalive: options.keepalive === true,
        signal: controller?.signal,
      });
    } catch (err) {
      const aborted = controller?.signal?.aborted === true;
      throw new CrossdeckError({
        type: "network_error",
        code: aborted ? "request_timeout" : "fetch_failed",
        message: aborted
          ? `Request to ${path} aborted after ${effectiveTimeout}ms`
          : err instanceof Error
            ? err.message
            : "fetch failed",
      });
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      throw await crossdeckErrorFromResponse(response);
    }

    // 204 No Content / OPTIONS-like — return undefined cast as T (callers
    // that don't expect a body shouldn't read it).
    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new CrossdeckError({
        type: "internal_error",
        code: "invalid_json_response",
        message: "Server returned a 2xx with an unparseable body.",
        requestId: response.headers.get("x-request-id") ?? undefined,
        status: response.status,
      });
    }
  }

  /**
   * Whether this client is in localhost dev-mode short-circuit. Used
   * by other SDK pieces (event-queue) to skip network-bound work
   * entirely rather than going through synthesizeLocalDevResponse.
   */
  get isLocalDevMode(): boolean {
    return this.config.localDevMode === true;
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    let url = base + cleanPath;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (typeof v === "string" && v.length > 0) params.append(k, v);
      }
      const qs = params.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    return url;
  }
}

/**
 * Build a synthetic response for localhost dev mode. Path-aware so
 * heartbeat / alias / entitlements / events callers each get a
 * sensible empty shape that won't crash downstream code.
 *
 * Heartbeat returns ok=true so the SDK considers itself "started."
 * Alias returns a stub `cdcust_local_*` so identify() resolves to a
 * stable ID across calls (we mint a per-tab one via crypto.randomUUID
 * once and remember it). Entitlements returns an empty list — the
 * dev should grant entitlements in their own dashboard before relying
 * on isEntitled() locally.
 */
let cachedLocalCdcust: string | null = null;
function synthesizeLocalDevResponse<T>(path: string): T {
  if (path.startsWith("/sdk/heartbeat")) {
    return {
      object: "heartbeat",
      ok: true,
      projectId: "proj_local_dev",
      appId: "app_local_dev",
      platform: "web",
      env: "sandbox",
      serverTime: Date.now(),
    } as unknown as T;
  }
  if (path.startsWith("/identity/alias")) {
    if (!cachedLocalCdcust) {
      const tail =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
          : Math.random().toString(36).slice(2, 18);
      cachedLocalCdcust = `cdcust_local_${tail}`;
    }
    return {
      object: "alias_result",
      crossdeckCustomerId: cachedLocalCdcust,
      linked: [],
      mergePending: false,
      env: "sandbox",
    } as unknown as T;
  }
  if (path.startsWith("/entitlements")) {
    return {
      object: "list",
      data: [],
      crossdeckCustomerId: cachedLocalCdcust ?? "",
      env: "sandbox",
    } as unknown as T;
  }
  if (path.startsWith("/events")) {
    return {
      object: "list",
      received: 0,
      env: "sandbox",
    } as unknown as T;
  }
  // Generic fallback — empty success shape.
  return {} as T;
}
