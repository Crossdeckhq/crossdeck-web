/**
 * _diagnostic-telemetry.ts
 *
 * Single-fire reliability telemetry for the SDK. Carries the
 * `crossdeck.contract_failed` event ONE WAY to the Crossdeck
 * reliability endpoint — NEVER the customer's appId, NEVER the
 * customer's track() pipeline, NEVER visible in the customer's
 * dashboard.
 *
 * Why this exists
 * ───────────────────────────────────────────────────────────────────
 * Crossdeck is an independent controller for SDK Diagnostic
 * Telemetry (Privacy Policy §6, "Flow B"). The legitimate-interest
 * basis depends on the payload remaining diagnostic-only: no
 * end-user identifiers, no free-form text, no stack frames. The
 * schema-lock contract at
 * `contracts/diagnostics/contract-failed-payload-schema-lock.json`
 * fixes the wire shape; this module is the call site that has to
 * honour it.
 *
 * Why bypass the existing HttpClient
 * ───────────────────────────────────────────────────────────────────
 * The HttpClient is configured for the customer's project (their
 * API key, their endpoint). Routing reliability telemetry through
 * it would (a) bill against the customer's event quota and (b)
 * show individual contract failures in their dashboard, which is
 * neither the customer's nor Crossdeck's intent. A separate one-way
 * path is the structural guarantee.
 *
 * PROVISIONING NOTE
 * ───────────────────────────────────────────────────────────────────
 * The reliability endpoint URL + publishable key below are LITERAL
 * CONSTANTS shipped in the SDK. Until the reliability project is
 * minted, the placeholder values disable telemetry — the function
 * returns early without making a request. After provisioning, swap
 * the placeholders for the real values; the same values go into the
 * backend at backend/src/api/v1-sdk-diagnostic.ts.
 */

import { SDK_NAME, SDK_VERSION } from "./_version";

/**
 * Reliability endpoint URL — `/v1/events`, the SAME endpoint customer
 * `cd.track()` calls use. Contract failures land as ordinary
 * `crossdeck.contract_failed` events in the Crossdeck reliability
 * project's events warehouse (resolved via the hardcoded reliability
 * publishable key below). They surface in the Crossdeck team's
 * events-explorer alongside any other custom event on that project
 * — no separate dashboard surface required.
 *
 * Pre-2026-05-28 this pointed at `/v1/sdk/diagnostic`, a Crossdeck-
 * specific endpoint that wrote to a top-level `sdkDiagnostics`
 * collection. That endpoint has no dashboard renderer; failures
 * piled up invisibly. Routing through `/v1/events` reuses the
 * generic custom-event pipeline + UI any customer would have for
 * their own track() calls.
 */
export const DIAGNOSTIC_TELEMETRY_ENDPOINT =
  "https://api.cross-deck.com/v1/events";

/** Reliability project's publishable key. Hardcoded constant.
 *  Provisioned 2026-05-27 — Crossdeck reliability workspace
 *  (app_web_92b2d6a5728a4d). Every customer SDK's contract_failed
 *  events route here for Crossdeck-on-Crossdeck observability. */
export const DIAGNOSTIC_TELEMETRY_PUBLISHABLE_KEY =
  "cd_pub_live_9490e7aa029c432abf";

/**
 * Whether the telemetry is enabled. Disabled while the reliability
 * project is unprovisioned (placeholder key in place).
 */
export function isDiagnosticTelemetryEnabled(): boolean {
  return !DIAGNOSTIC_TELEMETRY_PUBLISHABLE_KEY.startsWith(
    "cd_pub_RELIABILITY_PLACEHOLDER",
  );
}

/**
 * The exhaustive set of fields the payload may contain — mirrors the
 * schema-lock contract. Anything outside this set is dropped at the
 * call site so a future caller can't accidentally widen the wire
 * shape.
 */
export const DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "contract_id",
  "sdk_version",
  "sdk_platform",
  "failure_reason",
  "run_context",
  "run_id",
  "test_file",
  "test_name",
  "device_class",
  // verification_phase is set by the runtime contract verifier layer
  // (sdks/web/src/_contract-verifiers.ts) — values `boot` / `hot_path`.
  // Absent for failures emitted by external test harnesses
  // (XCTestObservation, Vitest hooks, JUnit watchers) which carry
  // test_file + test_name instead. See contracts/diagnostics/
  // contract-failed-payload-schema-lock.json.
  "verification_phase",
]);

/**
 * Whitelist filter — even if a caller threads a forbidden key
 * (anonymousId, ip, etc.) through, it never hits the wire. The
 * backend would reject it anyway; this is defence in depth.
 *
 * Exported so unit tests can verify the schema-lock without needing
 * to monkey-patch fetch or wait for the reliability endpoint to be
 * provisioned.
 */
export function filterDiagnosticPayload(
  payload: Record<string, string>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS.has(k) && typeof v === "string") {
      filtered[k] = v;
    }
  }
  return filtered;
}

/**
 * Fire-and-forget POST to the reliability endpoint. Returns
 * immediately. Never throws — failures are silently dropped so the
 * customer's app is not affected by reliability-endpoint
 * availability.
 *
 * @param payload key/value map of payload fields. Keys not in
 *   {@link DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS} are dropped before
 *   serialisation.
 */
export function sendDiagnosticTelemetry(
  payload: Record<string, string>,
): void {
  if (!isDiagnosticTelemetryEnabled()) return;
  const filtered = filterDiagnosticPayload(payload);
  if (Object.keys(filtered).length === 0) return;

  // Wrap as the /v1/events batch shape — single event per fire,
  // `name: "crossdeck.contract_failed"`, all schema-lock fields as
  // properties. The reliability publishable key resolves to the
  // Crossdeck reliability project server-side; the event lands in
  // that project's events warehouse and surfaces in its
  // events-explorer like any other custom event.
  const body = JSON.stringify({
    events: [
      {
        name: "crossdeck.contract_failed",
        timestamp: Date.now(),
        properties: filtered,
      },
    ],
  });

  // Browser path: fetch with keepalive so the request survives a
  // page-unload that fires immediately after the call. Node-only
  // builds never hit this branch (the SDK selects `crossdeck-server`
  // for that runtime). If fetch is unavailable (older WebViews), the
  // request is silently dropped — operational telemetry is not
  // worth surfacing in a customer-facing error.
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== "function") return;

  try {
    void f(DIAGNOSTIC_TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DIAGNOSTIC_TELEMETRY_PUBLISHABLE_KEY}`,
        "Crossdeck-Sdk-Version": `${SDK_NAME}@${SDK_VERSION}`,
      },
      body,
      keepalive: true,
      // No credentials, no cache, no referrer — the reliability
      // endpoint is the same origin only in tests. In production the
      // browser never carries anything beyond the request body and
      // the Authorization header we set explicitly.
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    }).catch(() => {
      // Fire-and-forget; we never want a rejection bubbling into the
      // host app's unhandledrejection handler.
    });
  } catch {
    // Swallow synchronous throws (CSP block, immediate failure).
  }
}
