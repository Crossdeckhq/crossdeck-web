/**
 * Internal-traffic browser opt-out.
 *
 * Visiting any tracked page with `?crossdeck_internal=1` persists a flag in
 * localStorage; every event from this browser is then tagged with the
 * reserved `$crossdeck_internal` property, which ingest reads to classify
 * the event as internal. `?crossdeck_internal=0` clears it.
 *
 * This covers the cases identity- and IP-based rules miss: a dynamic home
 * IP, or browsing your own product logged out. It's per-browser and
 * self-service — no dashboard change required to set or clear it.
 *
 * Design: the URL is parsed ONCE at init (processInternalOptOutUrl) to
 * set/clear the persisted flag; each event then does a cheap localStorage
 * read (isInternalOptOut) so clearing takes effect immediately. Everything
 * is wrapped — SSR / Node / private-mode / disabled-storage all degrade to
 * "not opted out", never a throw.
 */

/**
 * The reserved property key stamped on every event while opted out. Must
 * match the backend contract (backend/src/api/lib/actor-type.ts:
 * INTERNAL_OPT_OUT_PROPERTY). `$`-prefixed so it can't collide with a
 * developer's own property names.
 */
export const INTERNAL_OPT_OUT_PROPERTY = "$crossdeck_internal";

const STORAGE_KEY = "crossdeck.internalOptOut";

function localStore(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Run once at init. A `?crossdeck_internal=1` (or `=true`) in the current
 * URL persists the opt-out flag; `=0` (or `=false`) clears it. No param →
 * leaves the existing persisted state untouched.
 */
export function processInternalOptOutUrl(): void {
  try {
    const search = typeof location !== "undefined" ? location.search : "";
    const params = new URLSearchParams(search || "");
    if (!params.has("crossdeck_internal")) return;
    const store = localStore();
    if (!store) return;
    const v = params.get("crossdeck_internal");
    if (v === "1" || v === "true") {
      store.setItem(STORAGE_KEY, "1");
    } else if (v === "0" || v === "false") {
      store.removeItem(STORAGE_KEY);
    }
  } catch {
    /* no-op — never let opt-out handling break init */
  }
}

/** Cheap per-event check: is this browser currently opted out? */
export function isInternalOptOut(): boolean {
  try {
    return localStore()?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
