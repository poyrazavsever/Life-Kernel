import js from "@eslint/js";
import tseslint from "typescript-eslint";

// A small rule set that catches real mistakes without restyling the code: the recommended rules, plus the two
// type-aware rules that matter most for a server full of async I/O (a dropped promise hides a failed write).
// Type-aware rules need each file in a tsconfig project, and the core project leaves its tests out of the
// build, so tests get the plain recommended rules.
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "vaults/**", "private-docs/**", ".agents/**", ".tmp/**", "templates/**", "scripts/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    ignores: ["**/*.test.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }]
    }
  },
  {
    files: ["**/*.ts"],
    rules: {
      // Unused names are fine when they start with an underscore (destructuring to drop a field).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
    }
  }
);
