/**
 * Device + environment enrichment.
 *
 * Auto-attached to every event the SDK emits when `autoTrack.deviceInfo` is
 * enabled (default). Caller-supplied event properties always override
 * auto-detected ones (so a developer can manually set `app.version` per
 * event if they want to A/B between builds).
 *
 * Privacy posture:
 *   - No fingerprinting (no canvas hashes, no font enumeration).
 *   - No precise geolocation (only timezone + locale, both of which the
 *     browser exposes to every page anyway).
 *   - No IP collection — the backend logs the request IP for rate-limit
 *     purposes; it isn't stored on the event document.
 *   - All fields are typed enums or short strings; we never echo back
 *     full User-Agent strings to avoid surfacing fingerprintable detail
 *     in dashboards.
 */

export interface DeviceInfo {
  os?: string;
  osVersion?: string;
  browser?: string;
  browserVersion?: string;
  locale?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  devicePixelRatio?: number;
  /** Caller-supplied. Set via Crossdeck.start({ appVersion: "1.2.3" }). */
  appVersion?: string;
}

/**
 * Are we in a browser context? Pure function; no side effects.
 *
 * Detects: globalThis.window AND globalThis.document AND globalThis.navigator.
 * All three must be present — Workers / Service Workers have window but
 * no document, and Node 18+ now has navigator but no window.
 */
export function isBrowser(): boolean {
  return (
    typeof (globalThis as { window?: unknown }).window !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined" &&
    typeof (globalThis as { navigator?: unknown }).navigator !== "undefined"
  );
}

/**
 * Collect every safe-to-attach environment field. Returns an empty object
 * outside browsers (Node, Workers) — caller can pass appVersion via the
 * `extra` argument for non-browser runtimes.
 */
export function collectDeviceInfo(extra?: { appVersion?: string }): DeviceInfo {
  const info: DeviceInfo = {};
  if (extra?.appVersion) info.appVersion = extra.appVersion;

  if (!isBrowser()) return info;

  const w = (globalThis as { window: Window }).window;
  const nav = (globalThis as { navigator: Navigator }).navigator;
  const doc = (globalThis as { document: Document }).document;

  // ----- Locale + timezone -----
  try {
    if (typeof nav.language === "string") info.locale = nav.language;
  } catch {}
  try {
    info.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {}

  // ----- Screen + viewport -----
  try {
    if (w.screen) {
      info.screenWidth = w.screen.width;
      info.screenHeight = w.screen.height;
    }
    info.viewportWidth = w.innerWidth;
    info.viewportHeight = w.innerHeight;
    info.devicePixelRatio = w.devicePixelRatio;
  } catch {}

  // ----- Browser + OS from User-Agent -----
  try {
    const ua = nav.userAgent ?? "";
    const parsed = parseUserAgent(ua);
    Object.assign(info, parsed);
  } catch {}

  // ua-ch hints (Chromium browsers expose these properly without UA-string parsing)
  try {
    const uaData = (nav as Navigator & {
      userAgentData?: { platform?: string; brands?: Array<{ brand: string; version: string }> };
    }).userAgentData;
    if (uaData?.platform && !info.os) info.os = uaData.platform;
    if (uaData?.brands && !info.browser) {
      // Pick the most-specific non-"Not.A;Brand" entry
      const real = uaData.brands.find(
        (b) => !/Not[ .;A]*Brand/i.test(b.brand) && !/Chromium/i.test(b.brand),
      );
      if (real) {
        info.browser = real.brand;
        info.browserVersion = real.version;
      }
    }
  } catch {}

  // Suppress empties (a doc not yet hydrated could leave fields undefined)
  void doc; // referenced only for the isBrowser narrowing
  return info;
}

/**
 * Tiny User-Agent parser — extracts os, osVersion, browser, browserVersion.
 *
 * Doesn't try to be a full UA database (Bowser, ua-parser-js are large
 * deps). Covers ~95% of real-world traffic by recognising the major
 * browsers and operating systems. Unknown UAs fall through silently.
 *
 * Exported for unit testing.
 */
export function parseUserAgent(ua: string): Partial<DeviceInfo> {
  const out: Partial<DeviceInfo> = {};

  // ----- Operating system -----
  // Order matters: iPad/iPhone before Mac (iPadOS 13+ UAs claim "Macintosh"),
  // Android before Linux (Android UAs contain "Linux").
  if (/iPad|iPhone|iPod/.test(ua)) {
    out.os = "iOS";
    const m = ua.match(/OS (\d+[._]\d+(?:[._]\d+)?)/);
    if (m?.[1]) out.osVersion = m[1].replace(/_/g, ".");
  } else if (/Android/.test(ua)) {
    out.os = "Android";
    const m = ua.match(/Android (\d+(?:\.\d+)*)/);
    if (m?.[1]) out.osVersion = m[1];
  } else if (/Windows/.test(ua)) {
    out.os = "Windows";
    const m = ua.match(/Windows NT (\d+\.\d+)/);
    if (m?.[1]) out.osVersion = m[1];
  } else if (/Mac OS X|Macintosh/.test(ua)) {
    out.os = "macOS";
    const m = ua.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/);
    if (m?.[1]) out.osVersion = m[1].replace(/_/g, ".");
  } else if (/Linux/.test(ua)) {
    out.os = "Linux";
  }

  // ----- Browser -----
  // Order matters: Edge before Chrome (Edge UA contains "Chrome"),
  // Chrome before Safari (Chrome UA contains "Safari").
  if (/Edg\/(\d+(?:\.\d+)*)/.test(ua)) {
    out.browser = "Edge";
    out.browserVersion = ua.match(/Edg\/(\d+(?:\.\d+)*)/)?.[1];
  } else if (/Firefox\/(\d+(?:\.\d+)*)/.test(ua)) {
    out.browser = "Firefox";
    out.browserVersion = ua.match(/Firefox\/(\d+(?:\.\d+)*)/)?.[1];
  } else if (/OPR\/(\d+(?:\.\d+)*)/.test(ua)) {
    out.browser = "Opera";
    out.browserVersion = ua.match(/OPR\/(\d+(?:\.\d+)*)/)?.[1];
  } else if (/Chrome\/(\d+(?:\.\d+)*)/.test(ua)) {
    out.browser = "Chrome";
    out.browserVersion = ua.match(/Chrome\/(\d+(?:\.\d+)*)/)?.[1];
  } else if (/Version\/(\d+(?:\.\d+)*).*Safari/.test(ua)) {
    out.browser = "Safari";
    out.browserVersion = ua.match(/Version\/(\d+(?:\.\d+)*)/)?.[1];
  }

  return out;
}
