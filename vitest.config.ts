import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One temporary root per run, removed afterwards (test/tools/temp-root.ts).
    globalSetup: ["test/tools/vitest-global-setup.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
          exclude: ["node_modules/**", "test/guards/**", "test/e2e/**", "test/web/**"],
          environment: "node",
        },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          include: ["test/web/**/*.test.ts", "test/web/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["test/fixtures/web/setup.ts"],
        },
      },
      {
        test: {
          name: "guards",
          include: ["test/guards/**/*.test.ts"],
          exclude: ["node_modules/**", "test/guards/fixtures/**"],
          environment: "node",
          // Each guard parses the whole repository; it grows with the code, not with load.
          testTimeout: 30_000,
        },
      },
    ],
  },
});
