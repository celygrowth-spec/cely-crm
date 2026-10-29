import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60000, hookTimeout: 120000 },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      // « server-only » refuse d'être importé hors d'un Server Component : neutralisé pour les tests
      "server-only": resolve(import.meta.dirname, "tests/stubs/empty.ts"),
    },
  },
});
