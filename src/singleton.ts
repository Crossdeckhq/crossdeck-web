/**
 * The ONE Crossdeck singleton — shared across every entry point.
 *
 * Why this module exists (the biotree defect, CD-155): `@cross-deck/web` and
 * `@cross-deck/web/react` build as SEPARATE bundles. Each one inlined
 * `crossdeck.ts` — including a bare `export const Crossdeck = new
 * CrossdeckClient()` — so the shipped package contained TWO singletons: one in
 * `index.mjs`, a different object baked into `react.mjs`. A React app that did
 * `Crossdeck.init()` / `identify()` / `getEntitlements()` on the core import
 * warmed instance A, while `useEntitlement()` (react entry) read instance B,
 * which was never initialised — so a paying customer read `false` forever. No
 * error, no warning; a silent duplicate-singleton hazard. In source the import
 * is single; the split is purely a bundling artefact.
 *
 * The fix that CANNOT regress: back the instance with the cross-realm global
 * symbol registry. `Symbol.for(key)` returns the same symbol everywhere, so no
 * matter how many times a bundler duplicates this module, every copy resolves
 * to the SAME instance. This is the same guard PostHog, Segment, and
 * LaunchDarkly use for their React bindings, for this exact reason.
 */
import { CrossdeckClient } from "./crossdeck";

/** Cross-realm registry key — identical across every bundled copy. */
const INSTANCE_KEY = Symbol.for("@cross-deck/web:Crossdeck");
/** Marks that the singleton module body has already run once in this realm. */
const MODULE_EVAL_KEY = Symbol.for("@cross-deck/web:singletonModuleEvaluated");

interface SingletonRegistry {
  [INSTANCE_KEY]?: CrossdeckClient;
  [MODULE_EVAL_KEY]?: boolean;
}
const g = globalThis as typeof globalThis & SingletonRegistry;

// Dev signal: if this module body evaluates more than once, the bundler shipped
// duplicate copies across entry points (the very condition that spawned the
// two-instance bug). It's now HARMLESS — the registry below still hands back
// one instance — but flag it so a bundler misconfiguration can never silently
// regress into two live singletons again.
if (
  g[MODULE_EVAL_KEY] &&
  typeof process !== "undefined" &&
  process.env?.NODE_ENV !== "production" &&
  typeof console !== "undefined"
) {
  console.warn(
    "[crossdeck] The SDK singleton module was loaded more than once — " +
      "@cross-deck/web appears to be bundled as duplicate copies across entry " +
      "points (e.g. the core and /react bundles). All copies still resolve to " +
      "ONE instance via the global registry, so entitlements/identity stay " +
      "correct; but verify your bundler dedupes @cross-deck/web to keep the " +
      "bundle lean.",
  );
}
g[MODULE_EVAL_KEY] = true;

/**
 * The default singleton — most consumers want one SDK instance per app. Every
 * entry point (`@cross-deck/web`, `@cross-deck/web/react`, `.../vue`) resolves
 * to THIS object. Creating extra instances is still fine for advanced use:
 * just `new CrossdeckClient()`.
 */
export const Crossdeck: CrossdeckClient = (g[INSTANCE_KEY] ??=
  new CrossdeckClient());
