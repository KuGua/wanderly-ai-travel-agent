// Test-only stub for `next/navigation`. The real module requires Next.js
// App Router context that Vitest's jsdom env cannot provide, so we hand
// back inert equivalents.  Tests that need to assert URL state should
// override these per-test with `vi.mock("next/navigation", ...)`.

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
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

export function useParams() {
  return {};
}

export function redirect(url: string) {
  return url;
}
