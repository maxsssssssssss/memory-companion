import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**", ".data/**"],
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    passWithNoTests: true
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
});
