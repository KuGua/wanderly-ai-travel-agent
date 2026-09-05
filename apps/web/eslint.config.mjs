import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Routing is `localePrefix: "always"` (src/i18n/routing.ts), so a bare
    // `next/link` href carries no locale segment: the middleware has to
    // redirect, and a reader whose locale is not the default can land on the
    // default-locale copy of the page they clicked from. `PinnedResultCard`
    // shipped that way and sent Chinese readers to the English planning-run
    // page. A single component test could not have caught it — the test stub
    // for `next-intl/navigation` renders the href verbatim — so the guard
    // belongs here, where it covers every future component at once.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/i18n/**", "src/test/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "next/link",
          message: "Use the locale-aware `Link` from @/i18n/navigation; next/link drops the locale prefix.",
        }, {
          name: "next/navigation",
          importNames: ["redirect", "usePathname", "useRouter"],
          message: "Use @/i18n/navigation so the locale segment survives navigation.",
        }],
      }],
    },
  },
]);

export default eslintConfig;
