"use client";

import { Globe2, ListChecks, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentType, SVGProps } from "react";

import { LocaleSwitcher } from "./locale-switcher";
import { AccountAuthControl } from "./account-auth-control";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

type NavEntry = {
  href: "/home" | "/projects" | "/profile";
  labelKey: "navExplore" | "navProgram" | "navProfile";
  icon: ComponentType<SVGProps<SVGSVGElement> & { "aria-hidden"?: boolean | "true" | "false" }>;
};

const navigation: readonly NavEntry[] = [
  { href: "/home", labelKey: "navExplore", icon: Globe2 },
  { href: "/projects", labelKey: "navProgram", icon: ListChecks },
  { href: "/profile", labelKey: "navProfile", icon: Settings2 },
] as const;

export function contentGridClass(pathname: string): string {
  // The Explore map is an immersive surface. Let the fixed rail float above
  // it instead of reserving a page-colour gutter behind the navigation.
  return pathname === "/home" ? "sm:col-span-2 sm:col-start-1" : "sm:col-start-2";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  const pathname = usePathname();

  // Strip the locale prefix before comparing to nav hrefs.
  const strippedPath = pathname.replace(/^\/(en|zh)/, "") || "/";

  return (
    // The desktop rail is fixed, so it leaves normal grid flow. The content
    // column is named explicitly (col 2) rather than left to auto-placement,
    // which would otherwise drop the page into the 88px rail gutter.
    <div className="min-h-screen bg-background sm:grid sm:grid-cols-[88px_minmax(0,1fr)]">
      <aside
        data-wanderly-avoid
        // The explore map canvas runs the full width of the window, under this
        // rail. The globe camera measures the rail so it can centre the planet
        // in the strip that is actually uncovered.
        data-wanderly-rail
        className={cn(
          "relative z-50 flex h-[62px] items-center gap-2 border-b-2 border-[var(--w-ink)] bg-sidebar px-3.5 py-2 text-sidebar-foreground",
          // Long floating navigation card on desktop.
          "sm:fixed sm:inset-y-[18px] sm:left-[14px] sm:h-auto sm:w-16 sm:flex-col sm:gap-[13px] sm:border-2 sm:px-2 sm:py-3 sm:wanderly-r-rail sm:wanderly-shadow-lg",
        )}
      >
        <Link
          href="/home"
          aria-label={t("exploreAriaLabel")}
          className="grid size-10 shrink-0 place-items-center border-2 border-[var(--w-ink)] bg-[var(--w-white)] font-black tracking-[-0.08em] text-[var(--w-ink)] wanderly-r-md wanderly-shadow-xs wanderly-press sm:size-11"
        >
          {t("brandGlyph")}
        </Link>

        <nav className="flex gap-1.5 sm:mt-1 sm:flex-col sm:gap-2" aria-label={t("primaryNavAriaLabel")}>
          {navigation.map(({ href, labelKey, icon: Icon }) => {
            const target = href;
            const active = strippedPath === target || (target === "/projects" && strippedPath.startsWith("/trips/"));
            const label = t(labelKey);
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                title={label}
                className={cn(
                  "grid size-10 place-items-center border-[1.5px] border-[var(--w-ink)] text-[var(--w-ink)] wanderly-r-sm wanderly-press sm:size-11",
                  active
                    ? "bg-[var(--w-highlight)] wanderly-shadow-xs"
                    : "bg-[var(--w-fog)] hover:bg-[var(--w-highlight)] hover:wanderly-shadow-xs",
                )}
              >
                <Icon aria-hidden="true" className="size-5" />
                <span className="sr-only">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:ml-0 sm:mt-auto sm:flex-col">
          <LocaleSwitcher />
          <AccountAuthControl />
        </div>
      </aside>

      <div className={cn("min-w-0", contentGridClass(strippedPath))}>{children}</div>
    </div>
  );
}
