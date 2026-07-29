import js from "@eslint/js";
import tseslint from "typescript-eslint";
import adherence from "../../packages/ui/adherence.oxlintrc.json" with { type: "json" };

// Same wiring as apps/web: the design-system adherence ruleset is authored as
// standard ESLint rules, so ESLint is the engine and the severity is raised to
// error. No raw hex/px or off-system fonts in the desktop webview either.
const adherenceRules = {
  "no-restricted-syntax": ["error", ...adherence.rules["no-restricted-syntax"].slice(1)],
  "no-restricted-imports": ["error", ...adherence.rules["no-restricted-imports"].slice(1)],
};

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "src-tauri/**", "*.config.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build scripts are Node ESM, not webview code: they legitimately use
    // process/console/fetch and none of the design-system rules apply.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", fetch: "readonly", process: "readonly" },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: adherenceRules,
  },
);
