import { defineConfig } from "vitest/config";

const isCI = ["true", "1"].includes(process.env.CI?.toLowerCase() ?? "");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    maxWorkers: isCI ? undefined : 8,
    include: ["src/**/*.test.ts", ".pi/extensions/**/*.test.ts"],
  },
});
