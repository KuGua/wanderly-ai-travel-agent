import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Stub server-only modules and the Next.js root-params helper so unit
      // tests can import components that transitively reference them. We
      // intentionally mock `next-intl/navigation` with a local stub because
      // the real module pulls in `next/navigation`, which requires Next.js
      // App Router context that Vitest's jsdom env cannot provide.
      "next-intl/server": fileURLToPath(new URL("./src/test/empty.ts", import.meta.url)),
      "next-intl/navigation": fileURLToPath(new URL("./src/test/mock-navigation.tsx", import.meta.url)),
      "next/root-params": fileURLToPath(new URL("./src/test/empty.ts", import.meta.url)),
      "next/navigation": fileURLToPath(new URL("./src/test/mock-next-navigation.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});