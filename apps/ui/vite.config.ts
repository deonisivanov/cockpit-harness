import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    // e2e/ belongs to Playwright; vitest owns only the co-located unit tests.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
})
