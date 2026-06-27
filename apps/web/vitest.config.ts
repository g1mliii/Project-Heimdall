import { defineConfig } from "vitest/config";

// Unit tests live under src/; the e2e/ Playwright specs run via `playwright test`,
// not vitest (Playwright's test() throws if a non-Playwright runner imports it).
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
});
