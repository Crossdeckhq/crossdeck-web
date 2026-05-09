import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points:
  //   index.ts → `@cross-deck/web` (the core SDK)
  //   react.ts → `@cross-deck/web/react` (the React bindings)
  //
  // The React subpackage is its own bundle so non-React consumers
  // don't pull in the react peer dep just by importing the core.
  entry: ["src/index.ts", "src/react.ts"],
  format: ["cjs", "esm"],
  // Match the package.json "exports" map — CJS is .cjs, ESM is .mjs.
  // tsup defaults to .js for CJS which would mean the consumer's
  // require() resolution lands on a file that doesn't exist relative
  // to the exports map.
  outExtension({ format }) {
    if (format === "cjs") return { js: ".cjs" };
    if (format === "esm") return { js: ".mjs" };
    return { js: ".js" };
  },
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  // We deliberately don't bundle anything — keep imports simple for tree-shaking.
  splitting: false,
  // React is a peer dependency on the consumer side; mark it external
  // so tsup doesn't try to bundle it. Core SDK has no third-party deps.
  external: ["react"],
});
