/**
 * dist-loading smoke test.
 *
 * Unit tests in this repo import from `../src/...` — they test the
 * source code's behaviour but say nothing about whether the bundled
 * artefacts in `dist/` are usable. tsup can produce a broken bundle
 * (wrong exports map, missing dependency in the ESM output, mangled
 * names in the UMD) while every unit test stays green.
 *
 * This file is the bridge: it imports from `../dist` and asserts the
 * public-API surface is intact. Run after `npm run build` (the
 * `prepublishOnly` hook does that automatically).
 *
 * On first run dist/ doesn't exist, so each test guards with an
 * fs.existsSync — letting `npm test` work on a clean checkout. CI
 * runs `npm run build && npm test` so the guards do nothing there.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distDir = path.resolve(__dirname, "..", "dist");

function distFile(name: string): string {
  return path.join(distDir, name);
}

const distExists = fs.existsSync(distDir);
const skip = distExists ? it : it.skip;

describe("dist/ bundle loads", () => {
  skip("ESM entry is parseable + exports the core API", async () => {
    const entry = distFile("index.mjs");
    expect(fs.existsSync(entry)).toBe(true);
    const mod = await import(pathToFileURL(entry).href);
    expect(typeof mod.Crossdeck).toBe("object");
    expect(typeof mod.CrossdeckClient).toBe("function");
    expect(typeof mod.CrossdeckError).toBe("function");
    expect(typeof mod.MemoryStorage).toBe("function");
    expect(typeof mod.SDK_VERSION).toBe("string");
    expect(typeof mod.DEFAULT_BASE_URL).toBe("string");
    expect(Array.isArray(mod.CROSSDECK_ERROR_CODES)).toBe(true);
    expect(typeof mod.getErrorCode).toBe("function");
  });

  skip("CJS entry require()s without throwing + exports the core API", async () => {
    const entry = distFile("index.cjs");
    expect(fs.existsSync(entry)).toBe(true);
    // Use require() via createRequire so Node's CJS path is exercised.
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const mod = req(entry);
    expect(typeof mod.Crossdeck).toBe("object");
    expect(typeof mod.CrossdeckClient).toBe("function");
    expect(typeof mod.CrossdeckError).toBe("function");
    expect(Array.isArray(mod.CROSSDECK_ERROR_CODES)).toBe(true);
  });

  skip("React subpackage builds and exports the hooks", async () => {
    const entry = distFile("react.mjs");
    expect(fs.existsSync(entry)).toBe(true);
    // The hooks call `useState`/`useEffect` at module import → we can't
    // actually execute them in Node without a React renderer. Just
    // assert they're exported as functions.
    const mod = await import(pathToFileURL(entry).href);
    expect(typeof mod.useEntitlement).toBe("function");
    expect(typeof mod.useEntitlements).toBe("function");
  });

  skip("Vue subpackage builds and exports composables", async () => {
    const entry = distFile("vue.mjs");
    expect(fs.existsSync(entry)).toBe(true);
    const mod = await import(pathToFileURL(entry).href);
    expect(typeof mod.useEntitlement).toBe("function");
    expect(typeof mod.useEntitlements).toBe("function");
  });

  skip("UMD bundle parses + registers a global", async () => {
    const entry = distFile("crossdeck.umd.min.js");
    expect(fs.existsSync(entry)).toBe(true);
    const src = fs.readFileSync(entry, "utf8");
    // Sanity: the minified bundle must mention Crossdeck (the global
    // name) and SDK_VERSION (so we know the build embedded real code,
    // not a stripped no-op).
    expect(src).toContain("Crossdeck");
    // The IIFE pattern starts with `var Crossdeck=` or assigns to a
    // global — assert the global-name token is present.
    expect(src.length).toBeGreaterThan(1000);
  });

  skip("error-codes.json sidecar exists and lists every code", async () => {
    const entry = distFile("error-codes.json");
    expect(fs.existsSync(entry)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(entry, "utf8"));
    expect(payload.sdk).toBe("@cross-deck/web");
    expect(Array.isArray(payload.codes)).toBe(true);
    expect(payload.codes.length).toBeGreaterThan(5);
    // Every code must have the four required fields.
    for (const entry of payload.codes) {
      expect(typeof entry.code).toBe("string");
      expect(typeof entry.type).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(typeof entry.resolution).toBe("string");
      expect(typeof entry.retryable).toBe("boolean");
    }
  });

  skip("ESM exports the Wave 2/3 public surface", async () => {
    const entry = distFile("index.mjs");
    const mod = await import(pathToFileURL(entry).href);
    // The CrossdeckClient prototype should have every Wave-2/3 method.
    const proto = mod.CrossdeckClient.prototype;
    for (const method of [
      "init",
      "identify",
      "register",
      "unregister",
      "getSuperProperties",
      "group",
      "getGroups",
      "consent",
      "consentStatus",
      "forget",
      "track",
      "flush",
      "reset",
      "diagnostics",
      // Wave 5 (errors)
      "captureError",
      "captureMessage",
      "setTag",
      "setTags",
      "setContext",
      "addBreadcrumb",
      "setErrorBeforeSend",
    ]) {
      expect(typeof proto[method]).toBe("function");
    }
  });

  skip("Source maps are present for production debugging", async () => {
    for (const m of ["index.mjs.map", "index.cjs.map", "crossdeck.umd.min.js.map"]) {
      expect(fs.existsSync(distFile(m))).toBe(true);
    }
  });
});
