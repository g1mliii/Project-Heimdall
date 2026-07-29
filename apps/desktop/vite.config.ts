import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for the Tauri webview (§21.1).
 *
 * `tauri dev` sets TAURI_DEV_HOST when developing against a device on the LAN;
 * everything else is a fixed port so tauri.conf.json's devUrl can be static.
 */
export default defineConfig({
  plugins: [react()],
  // Tauri serves the built bundle from a custom protocol — relative asset URLs.
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST ?? false,
    watch: {
      // The Rust half has its own watcher; Vite reloading on target/ churn
      // makes `tauri dev` unusable.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // WebView2 ships with the Windows the client requires; no legacy target.
    target: "chrome120",
    sourcemap: true,
  },
});
