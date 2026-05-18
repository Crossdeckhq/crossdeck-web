#!/usr/bin/env node
/**
 * Emit `dist/error-codes.json` from the typed `CROSSDECK_ERROR_CODES`
 * table in `src/error-codes.ts`. Run by `npm run build` AFTER tsup
 * produces the JS bundles.
 *
 * Why a sidecar JSON: AI integration assistants, error-aggregator
 * dashboards (Sentry, DataDog), and the Crossdeck dashboard itself
 * want a machine-readable index they can fetch without spinning up
 * a JS runtime. Same pattern as stripe.com/docs/error-codes (whose
 * source-of-truth ships in their SDK tarball under
 * `dist/error-codes.json`).
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distDir = path.resolve(new URL(".", import.meta.url).pathname, "../dist");
const target = path.join(distDir, "error-codes.json");

// Load the compiled ESM bundle — tsup just produced it.
const esmEntry = path.join(distDir, "index.mjs");
if (!fs.existsSync(esmEntry)) {
  console.error(`[emit-error-codes] dist/index.mjs not found — run npm run build first.`);
  process.exit(1);
}

const mod = await import(pathToFileURL(esmEntry).href);
const codes = mod.CROSSDECK_ERROR_CODES;
if (!Array.isArray(codes)) {
  console.error(`[emit-error-codes] CROSSDECK_ERROR_CODES is not exported from index.mjs.`);
  process.exit(1);
}

const payload = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  generatedAt: new Date().toISOString(),
  sdk: "@cross-deck/web",
  codes,
};

fs.writeFileSync(target, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`[emit-error-codes] wrote ${codes.length} entries to dist/error-codes.json`);
