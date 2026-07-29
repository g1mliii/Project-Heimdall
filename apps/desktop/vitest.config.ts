import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * The desktop JS half must pass on the ubuntu CI runner (the Rust half is the
 * Windows job), so nothing here may touch a Tauri runtime — component tests
 * mock the IPC module.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test-setup.ts"],
    css: false,
  },
});
