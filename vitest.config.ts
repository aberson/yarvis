import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@yarvis/shared": fileURLToPath(new URL("./shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["{shared,server,web}/test/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 30_000,
  },
});
