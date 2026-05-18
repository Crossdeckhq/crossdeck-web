#!/usr/bin/env node
/**
 * Bundle-size budget enforcement.
 *
 * Runs after `npm run build` (via `npm run size`) and fails the
 * release if any of the published bundles exceeds its budget. The
 * budgets are gzipped-byte counts — what actually goes over the
 * wire when a CDN serves the file.
 *
 * Why this matters: an SDK that crept to 100 KB silently would be a
 * conversion-rate-killer for every customer's site. Locking in a
 * budget at release time is what Stripe / Mixpanel do too.
 *
 * Budgets are intentionally generous on the first release of each
 * subpackage; tighten later as we see the real shape.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const distDir = path.resolve(new URL(".", import.meta.url).pathname, "../dist");

// Budgets target the gzipped wire size. The React / Vue subpackages
// re-bundle the core (splitting: false in tsup.config.ts — keeps the
// publish artefact dependency-free and tree-shake-friendly for
// bundlers). Consumers only pay for ONE entry point, never both.
//
// For comparison (single-pillar SDKs):
//   Mixpanel-browser:   55 KB gz (analytics only)
//   Segment analytics.js: 30 KB gz (analytics only)
//   PostHog-js:         40 KB gz (analytics only)
//   Sentry browser:     30 KB gz (errors only)
//   RevenueCat web:     ~18 KB gz (revenue only)
//
// Crossdeck at ~30 KB ships all three (analytics + revenue + errors)
// in one bundle — competitive with single-pillar SDKs.
// CJS budget at 33 KB (May 2026): the CJS bundle includes CommonJS
// boilerplate that the ESM build avoids, plus all three pillars
// (analytics + revenue + errors) had small additions during the
// docs / playbook pass. Still well under the competitive ceiling
// (Sentry 30 KB errors-only, Mixpanel 55 KB analytics-only,
// PostHog 40 KB analytics-only). ESM and the framework builds stay
// at 32 KB — they're what most modern stacks ship.
const BUDGETS = [
  { file: "index.mjs", maxGzipKb: 32, label: "core ESM" },
  { file: "index.cjs", maxGzipKb: 33, label: "core CJS" },
  { file: "react.mjs", maxGzipKb: 32, label: "react ESM" },
  { file: "vue.mjs", maxGzipKb: 32, label: "vue ESM" },
  { file: "crossdeck.umd.min.js", maxGzipKb: 18, label: "UMD min" },
];

let failed = false;
console.log("\nBundle-size budget check (gzipped):");
console.log("─".repeat(60));

for (const { file, maxGzipKb, label } of BUDGETS) {
  const full = path.join(distDir, file);
  if (!fs.existsSync(full)) {
    console.log(`  ${label.padEnd(14)}  ${file.padEnd(28)}  MISSING`);
    failed = true;
    continue;
  }
  const raw = fs.readFileSync(full);
  const gzip = zlib.gzipSync(raw);
  const kb = gzip.length / 1024;
  const ok = kb <= maxGzipKb;
  const status = ok ? "ok" : "FAIL";
  const bar = `${kb.toFixed(2).padStart(6)} KB / ${String(maxGzipKb).padStart(3)} KB`;
  console.log(`  ${label.padEnd(14)}  ${file.padEnd(28)}  ${bar}  ${status}`);
  if (!ok) failed = true;
}

console.log("─".repeat(60));
if (failed) {
  console.error(
    "\nBundle-size budget exceeded. Either trim the change or update the\n" +
      "budget in scripts/check-bundle-size.mjs with a justifying CHANGELOG note.\n",
  );
  process.exit(1);
}
console.log("All bundles within budget.\n");
