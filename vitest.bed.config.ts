import { defineConfig } from "vitest/config";
import { BED_START_TIMEOUT_MS } from "./tests/bed/bed.ts";

export default defineConfig({
  test: {
    include: ["tests/bed/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: BED_START_TIMEOUT_MS,
    fileParallelism: false,
  },
});
