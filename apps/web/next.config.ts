import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Next.js blocks dev-only chunks requested through a LAN hostname unless it
  // is explicitly allow-listed. Keep this to the current trusted test host;
  // do not use a wildcard or a public/tunnel domain.
  allowedDevOrigins: ["10.91.182.185"],
  turbopack: {
    root: process.cwd(),
  },
  experimental: {
    // `radix-ui` is the umbrella meta-package; we only use `Slot` from
    // `@radix-ui/react-slot`. Loading the meta-package pulls every Radix
    // primitive into the bundle. optimizePackageImports prunes the unused
    // exports so the dependency tree stays small for dev compilation.
    // `aws-amplify` is intentionally NOT listed — it uses subpath imports
    // (see `apps/web/src/lib/auth/cognito-browser-auth.ts`) so there is no
    // barrel to collapse; the deferral happens in the auth provider instead.
    optimizePackageImports: ["radix-ui"],
  },
};

export default withNextIntl(nextConfig);
