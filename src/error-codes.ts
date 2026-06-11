/**
 * Machine-readable index of every error code the SDK can throw, with
 * a short description and a hint on what action to take. Published
 * verbatim as `crossdeck-error-codes.json` in the npm tarball so AI
 * integration assistants, error-aggregator dashboards (Sentry,
 * DataDog), and the Crossdeck dashboard can render human-friendly
 * messages without parsing freeform `message` strings.
 *
 * Stripe publishes the same surface at stripe.com/docs/error-codes;
 * developers love it because every code has a canonical "what does
 * this mean / what should I do" answer.
 *
 * Adding a new error code:
 *   1. Add the code string to the union in `errors.ts` (where used).
 *   2. Add an entry here.
 *   3. The next `npm run build` regenerates the JSON sidecar.
 *
 * Keep entries terse — the consumer surfaces this in tooltips and
 * automated tickets, not in long-form docs.
 */

export interface ErrorCodeEntry {
  /** The string thrown as CrossdeckError.code. */
  code: string;
  /** CrossdeckError.type — broad category. */
  type:
    | "authentication_error"
    | "permission_error"
    | "invalid_request_error"
    | "rate_limit_error"
    | "version_error"
    | "internal_error"
    | "network_error"
    | "configuration_error";
  /** One-sentence description. Surfaced verbatim in dashboards. */
  description: string;
  /** What the developer should do. Imperative phrasing. */
  resolution: string;
  /** True for codes the SDK can auto-recover from (no developer action). */
  retryable: boolean;
}

export const CROSSDECK_ERROR_CODES: readonly ErrorCodeEntry[] = Object.freeze([
  // ----- Configuration -----
  {
    code: "invalid_public_key",
    type: "configuration_error",
    description: "The publishable key passed to Crossdeck.init() doesn't start with cd_pub_.",
    resolution: "Copy the key from your Crossdeck dashboard → API keys page.",
    retryable: false,
  },
  {
    code: "missing_app_id",
    type: "configuration_error",
    description: "Crossdeck.init() was called without an appId.",
    resolution: "Add appId to your init options — find it in the dashboard's Apps page.",
    retryable: false,
  },
  {
    code: "invalid_environment",
    type: "configuration_error",
    description: "Crossdeck.init() requires environment: 'production' | 'sandbox'.",
    resolution: "Pass the literal string \"production\" or \"sandbox\" — no other values are accepted.",
    retryable: false,
  },
  {
    code: "environment_mismatch",
    type: "configuration_error",
    description: "The publishable key's env prefix doesn't match the declared environment option.",
    resolution: "Either change `environment` to match the key prefix (cd_pub_test_ ↔ sandbox, cd_pub_live_ ↔ production), or swap the key for one minted in the right env.",
    retryable: false,
  },
  {
    code: "not_initialized",
    type: "configuration_error",
    description: "An SDK method was called before Crossdeck.init().",
    resolution: "Call Crossdeck.init({ appId, publicKey, environment }) once at app startup before any other method.",
    retryable: false,
  },

  // ----- Identify / track / purchase argument validation -----
  {
    code: "missing_user_id",
    type: "invalid_request_error",
    description: "identify() was called with an empty userId.",
    resolution: "Pass a stable, non-empty user identifier from your auth layer — never a hardcoded placeholder.",
    retryable: false,
  },
  {
    code: "missing_event_name",
    type: "invalid_request_error",
    description: "track() was called without an event name.",
    resolution: "Pass a non-empty string as the first argument.",
    retryable: false,
  },
  {
    code: "missing_group_type",
    type: "invalid_request_error",
    description: "group() was called without a group type.",
    resolution: "Pass a non-empty type (e.g. \"org\", \"team\") as the first argument.",
    retryable: false,
  },
  {
    code: "missing_signed_transaction_info",
    type: "invalid_request_error",
    description: "syncPurchases() was called without StoreKit 2 signed transaction info.",
    resolution: "Pass the JWS string from Transaction.currentEntitlements / Transaction.updates.",
    retryable: false,
  },

  // ----- Network / transport -----
  {
    code: "fetch_failed",
    type: "network_error",
    description: "The underlying fetch() call failed (typically a network outage or DNS issue).",
    resolution: "Check the user's network. The SDK will retry automatically with exponential backoff.",
    retryable: true,
  },
  {
    code: "request_timeout",
    type: "network_error",
    description: "A request was aborted after the configured timeoutMs (default 15s).",
    resolution: "Check the user's connection. Increase timeoutMs in init options if the user is on a known-slow network.",
    retryable: true,
  },
  {
    code: "invalid_json_response",
    type: "internal_error",
    description: "The server returned a 2xx with an unparseable body.",
    resolution: "Likely a transient backend bug. Retry; if it persists, contact support with the requestId.",
    retryable: true,
  },

  // ----- Backend-emitted codes (v1.4.0 Phase 6.2 backfill) -----
  // Mirror of backend/src/api/v1-errors.ts ApiErrorCode. A developer
  // hitting any of these on the wire can look them up via
  // getErrorCode(code) for a canonical remediation step instead of
  // hunting through Slack history.
  {
    code: "missing_api_key",
    type: "authentication_error",
    description: "No Authorization header (or Crossdeck-Api-Key header) on the request.",
    resolution: "Make sure Crossdeck.init({ publicKey }) was called with a cd_pub_… key before the request fired. Re-check your env-vars in CI / Docker if the key is empty at runtime.",
    retryable: false,
  },
  {
    code: "invalid_api_key",
    type: "authentication_error",
    description: "The API key is malformed, unknown, or doesn't resolve to a project.",
    resolution: "Copy the key from your Crossdeck dashboard → API keys. Confirm prefix is cd_pub_test_ / cd_pub_live_ for client SDKs and cd_sk_test_ / cd_sk_live_ for the Node server SDK.",
    retryable: false,
  },
  {
    code: "key_revoked",
    type: "authentication_error",
    description: "The API key was revoked in the Crossdeck dashboard.",
    resolution: "Mint a fresh key in the dashboard → API keys → Create new, swap it in, and redeploy. The revoked key cannot be reactivated.",
    retryable: false,
  },
  {
    code: "identity_token_invalid",
    type: "authentication_error",
    description: "The Firebase / Apple / Google ID token supplied with the request didn't verify against the dashboard's configured signers.",
    resolution: "Refresh the token client-side (Firebase auth.currentUser.getIdToken(true)) and retry. If the failure persists, confirm the signer is registered under dashboard → Authentication → Identity sources.",
    retryable: true,
  },
  {
    code: "origin_not_allowed",
    type: "permission_error",
    description: "The Origin header isn't in the project's Allowed origins list.",
    resolution: "Add the origin (e.g. https://app.example.com) under dashboard → Settings → Allowed origins. Wildcards like https://*.example.com are supported.",
    retryable: false,
  },
  {
    code: "bundle_id_not_allowed",
    type: "permission_error",
    description: "The iOS bundle ID sent via X-Crossdeck-Bundle-Id isn't registered under this app's Apple identity lock.",
    resolution: "Add the bundle ID under dashboard → Apps → <your app> → iOS bundle IDs.",
    retryable: false,
  },
  {
    code: "package_name_not_allowed",
    type: "permission_error",
    description: "The Android package name sent via X-Crossdeck-Package-Name isn't registered under this app's Android identity lock.",
    resolution: "Add the package name under dashboard → Apps → <your app> → Android package names.",
    retryable: false,
  },
  {
    code: "env_mismatch",
    type: "permission_error",
    description: "The request env (inferred from key prefix) doesn't match the resolved app's configured env.",
    resolution: "Use a cd_pub_live_ / cd_sk_live_ key with a production app, cd_pub_test_ / cd_sk_test_ with a sandbox app. The two cannot cross.",
    retryable: false,
  },
  {
    code: "idempotency_key_in_use",
    type: "invalid_request_error",
    description: "An Idempotency-Key was reused for a request with a different body (Stripe-grade contract).",
    resolution: "Generate a fresh key for a different transaction, or reuse the key only with the EXACT same body. The v1.4.0 SDKs derive keys deterministically from the body so this should never fire on SDK-managed calls.",
    retryable: false,
  },
  {
    code: "rate_limited",
    type: "rate_limit_error",
    description: "Request rate exceeded the project's per-second cap.",
    resolution: "Honour the Retry-After header — the SDK does this automatically on managed retries. If you're hitting it from a custom code path, throttle to <100 req/s/key.",
    retryable: true,
  },
  {
    code: "internal_error",
    type: "internal_error",
    description: "Server-side issue. Safe to retry with backoff.",
    resolution: "The SDK retries automatically. If your code paths through to this error, contact support with the requestId from the response envelope.",
    retryable: true,
  },
  {
    code: "google_not_supported",
    type: "invalid_request_error",
    description: "POST /purchases/sync with rail=google is gated until the Play Developer API reconciliation worker ships.",
    resolution: "Until v1.5+, Google Play purchases verify via Real-time Developer Notifications. The SDK auto-track path handles this transparently for Android consumers.",
    retryable: false,
  },
  {
    code: "stripe_not_supported",
    type: "invalid_request_error",
    description: "POST /purchases/sync with rail=stripe is unsupported — Stripe Checkout's redirect flow uses platform webhooks instead.",
    resolution: "Wire Stripe via the standard Checkout / Customer Portal flow; Crossdeck reconciles via the platform webhook automatically. No SDK call needed.",
    retryable: false,
  },
  {
    code: "missing_required_param",
    type: "invalid_request_error",
    description: "A required field is absent from the request body.",
    resolution: "Inspect the error.message — the missing field name is included verbatim. Refer to the SDK's TypeScript types for the canonical request shape.",
    retryable: false,
  },
  {
    code: "invalid_param_value",
    type: "invalid_request_error",
    description: "A field is present but the value failed validation (wrong shape, wrong length, wrong enum value).",
    resolution: "Read error.message for the specific field + reason. SDK-managed call sites should never emit this — file a bug if you do.",
    retryable: false,
  },
  {
    code: "sdk_version_unsupported",
    type: "version_error",
    description: "HTTP 426 — your installed SDK sends an event format the server no longer accepts. The data is good; only the wire dialect is too old. The SDK PARKS automatically: events are held on-device (paused, not lost) and deliver on the next launch after you upgrade.",
    resolution: "Update @cross-deck/web to at least the version in error.minVersion and redeploy — the parked queue backfills automatically. See https://cross-deck.com/docs/sdk-event-durability/.",
    retryable: false,
  },
] as const);

/** Lookup helper — returns the entry matching a CrossdeckError.code, or undefined. */
export function getErrorCode(code: string): ErrorCodeEntry | undefined {
  return CROSSDECK_ERROR_CODES.find((e) => e.code === code);
}
