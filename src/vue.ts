/**
 * @cross-deck/web/vue — Vue 3 composables for the Crossdeck SDK.
 *
 * Mirrors @cross-deck/web/react in spirit: ties the entitlement cache
 * to Vue's reactive system so components re-render the moment the
 * server-side cache populates.
 *
 *   import { useEntitlement } from "@cross-deck/web/vue";
 *   const isPro = useEntitlement("pro");  // Ref<boolean>
 *
 * Why a separate subpackage: Vue is an optional peer dependency. The
 * core SDK has zero runtime deps; pulling Vue in unconditionally would
 * make non-Vue consumers pay for code they don't use. Same pattern as
 * `@cross-deck/web/react`.
 *
 * SSR safety: `onMounted` / `onScopeDispose` only run on the client.
 * The initial Ref value is the cache's current state (`false` pre-init),
 * so server output never claims a non-existent entitlement.
 */

import { ref, onMounted, onScopeDispose, type Ref } from "vue";
import { Crossdeck } from "./crossdeck";
import type { TrustTokenStatus } from "./trust";
export type { TrustTokenStatus };

/**
 * Reactive entitlement check. Returns a `Ref<boolean>` that updates
 * automatically whenever the cache mutates.
 *
 *   const isPro = useEntitlement("pro");
 *   // template: <span v-if="isPro">Pro</span>
 */
export function useEntitlement(key: string): Ref<boolean> {
  const r = ref<boolean>(safeIsEntitled(key));

  onMounted(() => {
    r.value = safeIsEntitled(key);
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = Crossdeck.onEntitlementsChange(() => {
        r.value = safeIsEntitled(key);
      });
    } catch {
      // Pre-init — the SDK isn't started yet. The composable just
      // returns false until something mutates the cache via a
      // post-init call.
    }
    onScopeDispose(() => {
      if (unsubscribe) unsubscribe();
    });
  });

  return r;
}

/**
 * Reactive list of active entitlement keys. Updates on every cache
 * mutation. Useful for rendering a "you have unlocked: ..." block.
 */
export function useEntitlements(): Ref<readonly string[]> {
  const r = ref<readonly string[]>(safeListKeys());

  onMounted(() => {
    r.value = safeListKeys();
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = Crossdeck.onEntitlementsChange((entitlements) => {
        r.value = entitlements.filter((e) => e.isActive).map((e) => e.key);
      });
    } catch {
      // Pre-init.
    }
    onScopeDispose(() => {
      if (unsubscribe) unsubscribe();
    });
  });

  return r;
}

/**
 * Crossdeck Trust — the human-proof panel as a Vue composable.
 *
 * Bind `el` to the element the panel mounts into; read `token` / `status`
 * reactively. Sits on `Crossdeck.trust.panel(...)`, takes the publishable key
 * from `init()`, and is fail-open (can't mint → status "unavailable", signup
 * still proceeds, server scores the absent token). Never throws.
 *
 * @example
 * <script setup>
 * import { useTrustToken } from "@cross-deck/web/vue";
 * const { el, token, status } = useTrustToken();
 * </script>
 * <template><div ref="el" /></template>
 */
export function useTrustToken(): {
  /** Template ref — bind to the mount element: `<div ref="el" />`. */
  el: Ref<HTMLElement | null>;
  /** The minted token, or null until it mints (or if the panel failed open). */
  token: Ref<string | null>;
  /** Lifecycle: pending → ready (minted) or unavailable (failed open). */
  status: Ref<TrustTokenStatus>;
} {
  const el = ref<HTMLElement | null>(null);
  const token = ref<string | null>(null);
  const status = ref<TrustTokenStatus>("pending");

  onMounted(() => {
    if (!el.value) return;
    const handle = Crossdeck.trust.panel({
      target: el.value,
      onToken: (t) => {
        token.value = t.token;
        status.value = "ready";
      },
      onUnavailable: () => {
        status.value = "unavailable";
      },
    });
    onScopeDispose(() => handle.destroy());
  });

  return { el, token, status };
}

function safeIsEntitled(key: string): boolean {
  try {
    return Crossdeck.isEntitled(key);
  } catch {
    return false;
  }
}

function safeListKeys(): readonly string[] {
  try {
    return Crossdeck.listEntitlements()
      .filter((e) => e.isActive)
      .map((e) => e.key);
  } catch {
    return [];
  }
}
