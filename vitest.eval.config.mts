// Module 5: runs the golden-set eval (evals/*.eval.ts) with real AI calls.
// Kept apart from `npm test`, which uses mock models and needs no key.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 20 * 60_000,
    hookTimeout: 60_000,
  },
});
