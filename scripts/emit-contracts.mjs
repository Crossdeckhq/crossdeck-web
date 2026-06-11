#!/usr/bin/env node
/**
 * Emit `dist/contracts.json` — the per-SDK bank-grade contracts
 * sidecar. Run by `npm run build` AFTER tsup produces the JS
 * bundles, in lockstep with `emit-error-codes.mjs`.
 *
 * Why a sidecar: the dogfood project + customer integration tests
 * + AI integration assistants + the dashboard contract page all
 * need a machine-readable index of the behavioural guarantees
 * this SDK ships. Bundling the contracts INTO the SDK package
 * means the customer's lockfile pins SDK code + contracts atomically
 * — drift between the SDK they're using and the contracts they're
 * asserting against becomes physically impossible.
 *
 * Source of truth: `contracts/**\/*.json` at the monorepo root.
 * This script filters by `appliesTo` containing "web", stamps the
 * SDK semver this artifact was bundled with into `bundledIn`, and
 * writes the matching subset.
 *
 * Same pattern as `emit-error-codes.mjs`; see `contracts/README.md`
 * for the full distribution architecture.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(__dirname, "..");
const distDir = path.join(sdkRoot, "dist");
const repoRoot = path.resolve(sdkRoot, "../..");
const contractsRoot = path.join(repoRoot, "contracts");
const target = path.join(distDir, "contracts.json");

const SDK_IDENTIFIER = "web";

/** Read SDK semver from the SDK's own package.json — the value
 * we stamp into every contract's `bundledIn` so customers can see
 * which SDK release shipped this contract snapshot. */
function readSdkVersion() {
  const pkgPath = path.join(sdkRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version) {
    console.error(`[emit-contracts] package.json missing version`);
    process.exit(1);
  }
  return pkg.version;
}

const sdkVersion = readSdkVersion();
const bundledIn = `@cross-deck/${SDK_IDENTIFIER}@${sdkVersion}`;

if (!fs.existsSync(distDir)) {
  console.error(
    `[emit-contracts] dist/ not found — run "npm run build" first; this script runs after tsup.`,
  );
  process.exit(1);
}

if (!fs.existsSync(contractsRoot)) {
  // Standalone build (the published public repo) mirrors only this SDK — the
  // monorepo contracts/ dir is absent. The dist/contracts.json sidecar is
  // optional (the contracts ship in the JS via _contracts-bundled.ts), so
  // skip it gracefully rather than failing the release.
  console.log(
    "[emit-contracts] contracts/ absent (standalone build) — skipping the optional dist/contracts.json sidecar",
  );
  process.exit(0);
}

/** Recursively collect every *.json under contracts/, skipping
 * non-contract files (the README, anything not under a pillar
 * subdirectory). */
function collectContracts(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectContracts(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
  return found;
}

const files = collectContracts(contractsRoot);
const matchingContracts = [];
for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[emit-contracts] failed to parse ${file}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed?.appliesTo)) {
    console.error(
      `[emit-contracts] ${file} has no appliesTo array — refusing to emit a broken sidecar.`,
    );
    process.exit(1);
  }
  if (parsed.appliesTo.includes(SDK_IDENTIFIER)) {
    matchingContracts.push({ ...parsed, bundledIn });
  }
}

// Stable sort for diff-friendliness: alphabetical by id.
matchingContracts.sort((a, b) => a.id.localeCompare(b.id));

const payload = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  generatedAt: new Date().toISOString(),
  sdk: `@cross-deck/${SDK_IDENTIFIER}`,
  sdkVersion,
  bundledIn,
  count: matchingContracts.length,
  contracts: matchingContracts,
};

fs.writeFileSync(target, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(
  `[emit-contracts] wrote ${matchingContracts.length} contract entries (applies_to includes "${SDK_IDENTIFIER}") to dist/contracts.json`,
);
