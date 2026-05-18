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
] as const);

/** Lookup helper — returns the entry matching a CrossdeckError.code, or undefined. */
export function getErrorCode(code: string): ErrorCodeEntry | undefined {
  return CROSSDECK_ERROR_CODES.find((e) => e.code === code);
}
