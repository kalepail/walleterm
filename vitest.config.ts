import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/config.ts",
        "src/mpp-channel.ts",
        "src/**/types.ts",
      ],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 96,
        functions: 98,
        branches: 88,
        statements: 96,
      },
    },
  },
});
