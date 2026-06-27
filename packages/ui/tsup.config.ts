import { defineConfig } from "tsup";

// Builds the React primitives to dist/ (ESM + generated .d.ts). JSX uses the
// automatic runtime (read from tsconfig `jsx: react-jsx`), so esbuild emits
// `react/jsx-runtime` imports and React stays an external peer. CSS/token assets
// are copied separately by scripts/copy-assets.mjs (run after this in `build`).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  external: ["react", "react-dom", "react/jsx-runtime"],
});
