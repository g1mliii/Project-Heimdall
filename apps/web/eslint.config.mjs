import js from "@eslint/js";
import tseslint from "typescript-eslint";
import adherence from "../../packages/ui/adherence.oxlintrc.json" with { type: "json" };

// The design-system adherence ruleset (packages/ui/adherence.oxlintrc.json) is
// authored as standard ESLint rules — `no-restricted-syntax` (raw hex / px /
// off-system fonts + per-component prop contracts) and `no-restricted-imports`
// (no deep component imports). oxlint can't run these rules, so ESLint is the
// engine; we read the options straight from the shared file (single source of
// truth) and raise the severity to error so violations fail `pnpm lint`.
const adherenceRules = {
  "no-restricted-syntax": ["error", ...adherence.rules["no-restricted-syntax"].slice(1)],
  "no-restricted-imports": ["error", ...adherence.rules["no-restricted-imports"].slice(1)],
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
      "*.config.ts",
      "e2e/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: adherenceRules,
  },
);
