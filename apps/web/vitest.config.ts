import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests live under src/; the e2e/ Playwright specs run via `playwright test`,
// not vitest (Playwright's test() throws if a non-Playwright runner imports it).
export default defineConfig({
  resolve: {
    // Mirror the tsconfig "@/*" path so route-handler tests import the same
    // module ids the app does (vi.mock("@/lib/r2") must hit the app's import).
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
});
