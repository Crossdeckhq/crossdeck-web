/**
 * Super properties + group analytics — Mixpanel pattern.
 *
 * **Super properties** are key/value pairs the developer registers ONCE
 * via `Crossdeck.register({ plan: "pro" })` that get attached to every
 * subsequent event of that SDK instance. They're the single most-used
 * feature in Mixpanel-style analytics: "every event from this user
 * should have `plan` and `appVersion` on it" instead of remembering to
 * pass them on every track() call.
 *
 * **Groups** are organisational identifiers: a customer might belong to
 * an `org` ("acme"), a `team` ("design"), and a `plan` ("enterprise").
 * Each event carries `$groups.{type}: id` so B2B dashboards can pivot:
 * "Acme's team:design has fired 142 paywall_shown events this week".
 *
 * Both surfaces live in this module because they share two traits:
 *   - They're set once, attached to every event automatically.
 *   - They persist across reloads via the same storage layer the SDK
 *     uses for identity (localStorage + cookie redundancy doesn't make
 *     sense here — these are larger and live longer; localStorage only
 *     is fine).
 *
 * The store is reset on `Crossdeck.reset()` (logout) — both super
 * properties and groups are cleared because their lifetime is tied
 * to the identified user, not the SDK instance.
 */

import type { KeyValueStorage } from "./types";

const KEY_SUPER = "super_props";
const KEY_GROUPS = "groups";

export class SuperPropertyStore {
  private superProps: Record<string, unknown> = {};
  private groups: Record<string, { id: string; traits?: Record<string, unknown> }> = {};

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly prefix: string,
  ) {
    this.superProps = readJson(storage, prefix + KEY_SUPER) ?? {};
    this.groups = readJson(storage, prefix + KEY_GROUPS) ?? {};
  }

  // ---------- super properties ----------

  /**
   * Merge new keys into the super-property bag. Returns a snapshot of
   * the resulting bag. Values that are `null` are deleted (Mixpanel
   * semantics — explicit null = "stop tracking this key").
   */
  register(props: Record<string, unknown>): Record<string, unknown> {
    for (const [k, v] of Object.entries(props)) {
      if (v === null) {
        delete this.superProps[k];
      } else if (v !== undefined) {
        this.superProps[k] = v;
      }
    }
    writeJson(this.storage, this.prefix + KEY_SUPER, this.superProps);
    return { ...this.superProps };
  }

  /** Remove a single super-property key. Idempotent. */
  unregister(key: string): void {
    if (key in this.superProps) {
      delete this.superProps[key];
      writeJson(this.storage, this.prefix + KEY_SUPER, this.superProps);
    }
  }

  /** Snapshot of the current super-property bag. */
  getSuperProperties(): Record<string, unknown> {
    return { ...this.superProps };
  }

  // ---------- groups ----------

  /**
   * Set a group membership. Passing `id: null` clears the membership
   * for that group type — the SDK stops attaching it to events.
   */
  setGroup(type: string, id: string | null, traits?: Record<string, unknown>): void {
    if (id === null) {
      delete this.groups[type];
    } else {
      this.groups[type] = traits !== undefined ? { id, traits } : { id };
    }
    writeJson(this.storage, this.prefix + KEY_GROUPS, this.groups);
  }

  /**
   * Snapshot of the current groups map, keyed by group type. Returned
   * shape mirrors what the SDK attaches to every event as
   * `$groups.{type}`. The `traits` sub-object is the most-recent
   * traits payload passed to `setGroup` for that type; null when none.
   */
  getGroups(): Record<string, { id: string; traits?: Record<string, unknown> }> {
    return JSON.parse(JSON.stringify(this.groups));
  }

  /**
   * The flat `{ type: id }` projection used for event-attachment. Stable
   * for fast every-event merge — we don't want to JSON-clone on each
   * track() call.
   */
  getGroupIds(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [type, info] of Object.entries(this.groups)) {
      out[type] = info.id;
    }
    return out;
  }

  /** Wipe both bags. Called by Crossdeck.reset() (logout). */
  clear(): void {
    this.superProps = {};
    this.groups = {};
    try {
      this.storage.removeItem(this.prefix + KEY_SUPER);
    } catch {
      // ignore
    }
    try {
      this.storage.removeItem(this.prefix + KEY_GROUPS);
    } catch {
      // ignore
    }
  }
}

function readJson<T>(storage: KeyValueStorage, key: string): T | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(storage: KeyValueStorage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / private mode — silent degrade. In-memory still holds
    // the current state; cross-tab sync just loses fidelity.
  }
}
