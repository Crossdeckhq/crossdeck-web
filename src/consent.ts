/**
 * Consent gating — GDPR / CCPA-grade kill switches.
 *
 * Three independent dimensions, each defaulting to "granted" but
 * runtime-overridable:
 *
 *   analytics  — track(), identify(), heartbeat(), session/page auto-
 *                emissions. Off → events drop silently, no network
 *                calls fire.
 *   marketing  — paid-traffic click IDs (gclid/fbclid/etc) and
 *                acquisition referrer URL. Off → these get scrubbed
 *                before they ever land in the event bag.
 *   errors     — error / breadcrumb / Web Vitals capture. Off → no
 *                webvitals.* events emitted, no error reporting (when
 *                Phase 3 errors land).
 *
 * Why this granularity: real consent banners offer "Analytics",
 * "Marketing", "Functional" as separate boxes. The SDK has to match.
 *
 * Default state: every dimension is granted. The developer must
 * explicitly call `Crossdeck.consent({ analytics: false })` before
 * the first event to opt OUT — same convention as Google Tag Manager
 * Consent Mode. To start in deny mode, call `init(...)` then
 * immediately `consent({ analytics: false, marketing: false, errors:
 * false })` before any user activity.
 *
 * DNT (Do Not Track) browser header is checked once at init and
 * applied as an automatic deny across all dimensions when
 * `respectDnt: true` is set in CrossdeckOptions (default false because
 * the industry has effectively deprecated DNT — but opt-in support
 * is the polite default for privacy-first apps).
 */

export interface ConsentState {
  analytics: boolean;
  marketing: boolean;
  errors: boolean;
}

const ALL_GRANTED: ConsentState = {
  analytics: true,
  marketing: true,
  errors: true,
};

export class ConsentManager {
  private state: ConsentState = { ...ALL_GRANTED };
  private dntDenied = false;

  constructor(options?: { respectDnt?: boolean }) {
    if (options?.respectDnt && this.detectDnt()) {
      this.dntDenied = true;
      this.state = { analytics: false, marketing: false, errors: false };
    }
  }

  /**
   * Merge new dimensions onto the current state. Returns the resulting
   * snapshot. DNT-derived denies cannot be flipped back on by a `set`
   * call — once the browser says "don't track", we don't track even if
   * the developer code disagrees. That's the contract.
   */
  set(partial: Partial<ConsentState>): ConsentState {
    if (this.dntDenied) return { ...this.state };
    for (const k of Object.keys(partial) as Array<keyof ConsentState>) {
      const v = partial[k];
      if (typeof v === "boolean") this.state[k] = v;
    }
    return { ...this.state };
  }

  /** Snapshot of the current state. */
  get(): ConsentState {
    return { ...this.state };
  }

  /** Convenience getters for hot paths. */
  get analytics(): boolean {
    return this.state.analytics;
  }
  get marketing(): boolean {
    return this.state.marketing;
  }
  get errors(): boolean {
    return this.state.errors;
  }

  /** True iff the constructor detected and applied DNT. */
  get isDntDenied(): boolean {
    return this.dntDenied;
  }

  private detectDnt(): boolean {
    try {
      const nav = (globalThis as { navigator?: Navigator }).navigator;
      if (!nav) return false;
      // Three historical spellings: navigator.doNotTrack (standard),
      // navigator.msDoNotTrack (IE), window.doNotTrack (Safari).
      // All return "1" / "yes" when the user has DNT enabled.
      const sources = [
        (nav as Navigator & { doNotTrack?: string }).doNotTrack,
        (nav as Navigator & { msDoNotTrack?: string }).msDoNotTrack,
        (globalThis as { doNotTrack?: string }).doNotTrack,
      ];
      return sources.some((v) => v === "1" || v === "yes");
    } catch {
      return false;
    }
  }
}

// ============================================================
// PII scrubbing — URL + property values
// ============================================================

/**
 * Email-shaped pattern. Reasonably restrictive — matches RFC 5322's
 * "obs-local-part" common case (the practical 99% of emails). We
 * deliberately don't try to match every legal email; the goal is
 * "if it looks like an email, scrub it" without false positives.
 */
const EMAIL_PATTERN =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Card-number shaped pattern. Matches sequences of 13-19 digits that
 * could be split by space or hyphen — the format every payment form
 * accepts. We don't validate Luhn; this is best-effort scrubbing,
 * not card-data tokenisation. If you're handling actual PAN data
 * you should not be passing it through analytics in the first place.
 */
// Anchor on a digit at both ends so trailing separators (space / hyphen)
// aren't pulled into the match — otherwise "4242 4242 4242 4242 today"
// scrubs as "<card>today" instead of "<card> today".
const CARD_PATTERN = /\b\d(?:[ -]?\d){12,18}\b/g;

// Sentinel tokens — aligned with backend/src/api/lib/scrub.ts which uses
// <email>, <card>, <uuid>, <cdcust>, <crossdeck_secret_key>, <aws_access_key>.
// Mismatched tokens between the SDK scrub and the backend's defence-in-
// depth scrub would split dashboard aggregation (the same event arriving
// from two paths would carry two different sentinels).
const REPLACEMENT_EMAIL = "<email>";
const REPLACEMENT_CARD = "<card>";

/**
 * Scrub a single string value: replace email-shaped substrings with
 * `<email>` and card-number-shaped substrings with `<card>`. Returns
 * the original string when nothing matched.
 *
 * Implementation note: we call `.replace()` unconditionally rather than
 * gating on `.test()`. The /g regexes are module-level so `.test()`
 * carries `lastIndex` state between calls — a prior match leaves
 * `lastIndex` mid-string and the next `.test()` can falsely return
 * false on a string that DOES match. `.replace(/g)` always scans the
 * full string regardless of `lastIndex`, so dropping the test-guard
 * removes the sharp edge at zero cost (when nothing matches, replace
 * returns the same `(===)` string).
 */
export function scrubPii(value: string): string {
  if (!value) return value;
  return value
    .replace(EMAIL_PATTERN, REPLACEMENT_EMAIL)
    .replace(CARD_PATTERN, REPLACEMENT_CARD);
}

/**
 * Walk an event's properties and replace PII-shaped strings in place.
 * Returns a new object with strings scrubbed; non-string values pass
 * through unchanged.
 *
 * Defensive copy — the input is never altered. Caller can pass the
 * result straight to the queue.
 *
 * Recursive: nested plain objects + arrays are walked. Without this,
 * an event like `{ user: { email: "wes@…" } }` would ship the email
 * unscrubbed because the top-level value is an object, not a string.
 * Pre-fix this was the SDK's #1 PII leak vector — every captured-error
 * report ships nested `frames[]` / `breadcrumbs[]` / `context{}` /
 * `http{}` shapes through here. Date / Map / Set / Error / class
 * instances pass through untouched (those are the
 * `validateEventProperties` sanitiser's job — this is the PII regex
 * pass only).
 */
export function scrubPiiFromProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(properties)) {
    out[k] = scrubValue(properties[k]);
  }
  return out;
}

function scrubValue(v: unknown): unknown {
  if (typeof v === "string") return scrubPii(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === "object" && (v as object).constructor === Object) {
    // Plain objects only — Date, Map, Set, Error, RegExp, class
    // instances are left untouched so we don't accidentally mutate
    // an Error's `message` and confuse the downstream error reporter.
    return scrubPiiFromProperties(v as Record<string, unknown>);
  }
  return v;
}
