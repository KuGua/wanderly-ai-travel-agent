// Test-only stub for `next-intl/navigation`. Components using locale-aware
// `Link` / `usePathname` / `useRouter` get inert equivalents under Vitest so
// the real `next/navigation` (which requires Next.js App Router context) is
// not pulled into the unit-test bundle.

import type { ReactNode } from "react";

type NextLinkProps = {
  href: string;
  children?: ReactNode;
  className?: string;
  "aria-label"?: string;
  "aria-current"?: "page" | undefined;
  title?: string;
  onClick?: (event: unknown) => void;
  type?: "button" | "submit" | "reset";
};

export const Link: React.FC<NextLinkProps> = ({ href, children, ...rest }) => {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
};

export function redirect(url: string) {
  // No-op for tests; router state is asserted by the test itself.
  return url;
}

export function usePathname(): string {
  return "/";
}

export function useRouter() {
  return {
    replace: () => undefined,
    push: () => undefined,
    refresh: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined,
  };
}

export function getPathname() {
  return "/";
}

// `createNavigation` is a no-op in tests; we just hand back the inert
// exports above so any `import { createNavigation } from "next-intl/navigation"`
// at module load still resolves.
export function createNavigation() {
  return { Link, redirect, usePathname, useRouter, getPathname };
}
