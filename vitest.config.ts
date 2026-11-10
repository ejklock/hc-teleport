import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/bed/**", "node_modules/**"],
    testTimeout: 20_000,
  },
});
