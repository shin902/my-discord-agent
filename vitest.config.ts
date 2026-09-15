import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    maxWorkers: process.env.CI ? undefined : 8,
    include: ["src/**/*.test.ts", ".pi/extensions/**/*.test.ts"],
  },
});
