import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["**/dist/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Plain-JS scripts run directly by node; TS files get their globals from @types/node.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
    },
  },
)
