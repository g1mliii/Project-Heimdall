import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "driver-csv-as-text",
      enforce: "pre",
      transform(source, id) {
        if (!id.endsWith(".csv")) return null;
        return { code: `export default ${JSON.stringify(source)};`, map: null };
      },
    },
  ],
  test: { include: ["src/**/*.test.ts"] },
});
