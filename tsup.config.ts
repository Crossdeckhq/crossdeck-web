import { defineConfig } from "tsup";

// Two-config build:
//   - The npm package output (index / react / vue subpackages, ESM + CJS).
//   - The IIFE bundle for CDN consumption (single file, minified,
//     attaches a global `window.Crossdeck`). Used by docs / homepage
//     snippets that want a `<script>` tag without a build step.

export default defineConfig([
  // ---------- npm package: ESM ----------
  // ESM splits, so the opt-in consent widget (dynamic-imported when
  // `consentBanner` is set) lands in its OWN chunk instead of being inlined
  // into core. Customers who never switch consent on never download it.
  {
    entry: {
      index: "src/index.ts",
      react: "src/react.ts",
      vue: "src/vue.ts",
      // `@cross-deck/web/consent` — the opt-in widget (CD-185).
      consent: "src/consent.entry.ts",
    },
    format: ["esm"],
    outExtension() {
      return { js: ".mjs" };
    },
    dts: false,
    sourcemap: true,
    clean: true,
    minify: false,
    splitting: true,
    external: ["react", "vue"],
  },
  // ---------- type declarations ----------
  // Emitted by their own pass so they land as `.d.ts` (the extension the
  // package.json "exports" map declares). The ESM/CJS passes above override
  // the JS extension, which would otherwise drag the declarations to
  // `.d.mts` / `.d.cts` and break every `types` entry.
  {
    entry: {
      index: "src/index.ts",
      react: "src/react.ts",
      vue: "src/vue.ts",
      consent: "src/consent.entry.ts",
    },
    dts: { only: true },
    clean: false,
    external: ["react", "vue"],
  },
  // ---------- npm package: CJS ----------
  // CJS does NOT split: esbuild's code splitting is ESM-only, and forcing it
  // duplicates shared code across chunks (measured: CJS grew instead of
  // shrinking). CJS is a compatibility path, not a browser-download path, so
  // it stays a single file and simply inlines the widget.
  {
    entry: {
      index: "src/index.ts",
      react: "src/react.ts",
      vue: "src/vue.ts",
      consent: "src/consent.entry.ts",
    },
    format: ["cjs"],
    outExtension() {
      return { js: ".cjs" };
    },
    dts: false,
    sourcemap: true,
    clean: false,
    minify: false,
    splitting: false,
    external: ["react", "vue"],
  },
  // ---------- IIFE CDN bundle ----------
  // Output: dist/crossdeck.umd.min.js. Exposes `window.Crossdeck` so
  // a developer with no build step can drop:
  //   <script src="https://cdn.cross-deck.com/web/0.10.0/crossdeck.umd.min.js"></script>
  //   <script>window.Crossdeck.init({ appId: "...", publicKey: "..." })</script>
  // into a plain HTML page. React / Vue bindings are NOT included —
  // CDN consumers are typically no-framework or pre-bundled apps.
  {
    entry: { "crossdeck.umd": "src/index.ts" },
    format: ["iife"],
    globalName: "Crossdeck",
    outExtension() {
      return { js: ".min.js" };
    },
    minify: true,
    sourcemap: true,
    // Don't wipe dist — the npm-package config above runs in parallel
    // and we share the same output directory.
    clean: false,
    splitting: false,
    dts: false,
    // Same external policy — keep frameworks out of the IIFE bundle.
    external: ["react", "vue"],
    // IIFE cannot code-split, so the consent widget would be inlined and
    // blow the budget for every script-tag user. Externalise it: the
    // dynamic import fails harmlessly at runtime and the SDK falls back to
    // `window.CrossdeckConsent` from the companion bundle below.
    esbuildPlugins: [
      {
        name: "externalize-consent",
        setup(build) {
          build.onResolve(
            { filter: /^\.\/consent-(banner|coexistence)$/ },
            () => ({ external: true }),
          );
        },
      },
    ],
  },
  // ---------- IIFE consent companion ----------
  // Output: dist/crossdeck-consent.umd.min.js → `window.CrossdeckConsent`.
  // Only needed by script-tag users who switch the banner on:
  //   <script src=".../crossdeck.umd.min.js"></script>
  //   <script src=".../crossdeck-consent.umd.min.js"></script>
  {
    entry: { "crossdeck-consent.umd": "src/consent.entry.ts" },
    format: ["iife"],
    globalName: "CrossdeckConsent",
    outExtension() {
      return { js: ".min.js" };
    },
    minify: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    dts: false,
    external: ["react", "vue"],
  },
]);
