import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Parse-path isomorphism (§Phase 3): the same code runs in the browser and
    // on the server, so src/ must never touch Node built-ins. Tests are Node-only
    // (they read fixtures from disk) and are exempt.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/testing/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "Parser source is isomorphic (browser + server): no Node built-ins under src/. Tests are exempt.",
            },
          ],
        },
      ],
    },
  },
);
