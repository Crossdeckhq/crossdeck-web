import { defineConfig } from "tsup";

// Two-config build:
//   - The npm package output (index / react / vue subpackages, ESM + CJS).
//   - The IIFE bundle for CDN consumption (single file, minified,
//     attaches a global `window.Crossdeck`). Used by docs / homepage
//     snippets that want a `<script>` tag without a build step.

export default defineConfig([
  // ---------- npm package ----------
  {
    entry: ["src/index.ts", "src/react.ts", "src/vue.ts"],
    format: ["cjs", "esm"],
    // Match the package.json "exports" map — CJS is .cjs, ESM is .mjs.
    outExtension({ format }) {
      if (format === "cjs") return { js: ".cjs" };
      if (format === "esm") return { js: ".mjs" };
      return { js: ".js" };
    },
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    // Tree-shaking-friendly: don't bundle internal modules.
    splitting: false,
    // React and Vue are peer dependencies on the consumer side; mark
    // them external so tsup doesn't try to bundle them. Core SDK has
    // no third-party deps.
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
  },
]);
