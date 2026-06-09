import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    // Give the internal API an absolute origin so node fetch can resolve it
    // (MSW intercepts it). The browser uses the relative "/api/posts".
    env: { INTERNAL_BASE_URL: "http://localhost" },
    coverage: {
      provider: "v8",
      // Enforce coverage only on the library core; app/config/client glue
      // (hooks, re-exports, type-only files) is exercised by the app, not units.
      include: ["src/lib/fetcher/**/*.ts"],
      exclude: [
        "src/lib/fetcher/index.ts",
        "src/lib/fetcher/types.ts",
        "src/lib/fetcher/hooks.ts",
        "**/__tests__/**",
      ],
      thresholds: {
        statements: 88,
        branches: 80,
        functions: 80,
        lines: 88,
      },
    },
  },
});
