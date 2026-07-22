/**
 * Web Vitals capture — LCP, INP, CLS, FCP, TTFB.
 *
 * Why hand-rolled, not the `web-vitals` library: that library is ~6 KB
 * gz and pulls in handlers for every metric ever published by Google,
 * many of which (FID, soft-navigation, etc.) are deprecated or
 * superseded. The five metrics below are the ones every dashboard
 * actually renders — LCP for perceived load, INP for responsiveness,
 * CLS for visual stability, FCP for first paint, TTFB for backend
 * speed. Total here is ~80 lines, zero runtime deps.
 *
 * Each metric fires as a Crossdeck event:
 *   `webvitals.lcp`  → properties: { valueMs }
 *   `webvitals.inp`  → properties: { valueMs }
 *   `webvitals.cls`  → properties: { value }      // unitless score
 *   `webvitals.fcp`  → properties: { valueMs }
 *   `webvitals.ttfb` → properties: { valueMs }
 *
 * Capture timing:
 *   - FCP, TTFB fire once after the page settles (typically <1s).
 *   - LCP, CLS fire at page hidden (visibilitychange→hidden) — the
 *     final value is only known when the user stops interacting
 *     with the page.
 *   - INP samples interactions and fires at page hidden.
 *
 * No-op outside browsers (PerformanceObserver missing) or when the
 * `autoTrack.webVitals` flag is false.
 */

type Reporter = (name: string, properties: Record<string, unknown>) => void;

export interface WebVitalsConfig {
  enabled: boolean;
  /**
   * Cap on the number of metric events emitted per page. Defaults to
   * one per metric type (so 5 max). Defends against a rogue browser
   * firing 100 PerformanceObserver entries.
   */
  maxEventsPerMetric?: number;
}

export class WebVitalsTracker {
  private observers: PerformanceObserver[] = [];
  private flushed = new Set<string>();
  private cls = 0;
  private clsEntries: PerformanceEntry[] = [];
  private inp = 0;
  private cleanups: Array<() => void> = [];

  constructor(
    private readonly cfg: WebVitalsConfig,
    private readonly report: Reporter,
  ) {}

  install(): void {
    if (!this.cfg.enabled) return;
    if (typeof PerformanceObserver === "undefined") return;
    if (typeof globalThis === "undefined" || !("document" in globalThis)) return;

    const doc = (globalThis as { document: Document }).document;

    // TTFB / FCP — fire as soon as we have data.
    try {
      const navObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceNavigationTiming;
          if (e.responseStart > 0 && !this.flushed.has("ttfb")) {
            this.flushed.add("ttfb");
            this.report("webvitals.ttfb", { valueMs: Math.round(e.responseStart - e.startTime) });
          }
        }
      });
      navObserver.observe({ type: "navigation", buffered: true });
      this.observers.push(navObserver);
    } catch {
      // not supported — fall through
    }

    try {
      const paintObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === "first-contentful-paint" && !this.flushed.has("fcp")) {
            this.flushed.add("fcp");
            this.report("webvitals.fcp", { valueMs: Math.round(entry.startTime) });
          }
        }
      });
      paintObserver.observe({ type: "paint", buffered: true });
      this.observers.push(paintObserver);
    } catch {
      // not supported
    }

    // LCP — track the LATEST entry; flush at page hidden.
    let lcpValue = 0;
    try {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) lcpValue = last.startTime;
      });
      lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
      this.observers.push(lcpObserver);
    } catch {
      // not supported
    }

    // CLS — accumulate per-session layout-shift score.
    try {
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // Layout-shift entries have a `value` field (cast loosely
          // since the typed DOM lib doesn't always expose it).
          const e = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (typeof e.value === "number" && !e.hadRecentInput) {
            this.cls += e.value;
            this.clsEntries.push(entry);
          }
        }
      });
      clsObserver.observe({ type: "layout-shift", buffered: true });
      this.observers.push(clsObserver);
    } catch {
      // not supported
    }

    // INP — find the worst-case interaction duration.
    try {
      const eventObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & { duration: number; interactionId?: number };
          if (e.interactionId && e.duration > this.inp) {
            this.inp = e.duration;
          }
        }
      });
      // The `event` type is the modern way; `first-input` is a fallback.
      // Wrapped in try because Safari < 16.4 throws on `event` type.
      try {
        eventObserver.observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
      } catch {
        eventObserver.observe({ type: "first-input", buffered: true });
      }
      this.observers.push(eventObserver);
    } catch {
      // not supported
    }

    // Flush LCP / CLS / INP at page-hidden — the final values are only
    // known after the user stops interacting.
    const flush = (): void => {
      // Unload-time defense: this fires on pagehide / visibilitychange→hidden,
      // and `report` enqueues (and can flush) through browser transport APIs
      // that in-app browsers (Instagram/Facebook's `iabjs://`, …) hook and
      // throw from during their own teardown. Swallow so the host shell's
      // teardown noise never propagates to window.onerror and gets
      // self-reported as the developer's error. The page is going away.
      try {
        if (lcpValue > 0 && !this.flushed.has("lcp")) {
          this.flushed.add("lcp");
          this.report("webvitals.lcp", { valueMs: Math.round(lcpValue) });
        }
        if (this.cls > 0 && !this.flushed.has("cls")) {
          this.flushed.add("cls");
          this.report("webvitals.cls", { value: Math.round(this.cls * 1000) / 1000 });
        }
        if (this.inp > 0 && !this.flushed.has("inp")) {
          this.flushed.add("inp");
          this.report("webvitals.inp", { valueMs: Math.round(this.inp) });
        }
      } catch {
        /* unload teardown — swallow */
      }
    };
    const onHidden = (): void => {
      if (doc.visibilityState === "hidden") flush();
    };
    doc.addEventListener("visibilitychange", onHidden);
    (globalThis as { window: Window }).window.addEventListener("pagehide", flush);
    this.cleanups.push(() => {
      doc.removeEventListener("visibilitychange", onHidden);
      (globalThis as { window: Window }).window.removeEventListener("pagehide", flush);
    });
  }

  uninstall(): void {
    for (const o of this.observers) {
      try {
        o.disconnect();
      } catch {
        // ignore
      }
    }
    this.observers = [];
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  }
}
