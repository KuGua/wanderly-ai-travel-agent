"use client";

import { Globe2, ListChecks, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentType, SVGProps } from "react";

import { LocaleSwitcher } from "./locale-switcher";
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  const pathname = usePathname();

  // Strip the locale prefix before comparing to nav hrefs.
  const strippedPath = pathname.replace(/^\/(en|zh)/, "") || "/";

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[5.5rem_minmax(0,1fr)]">
      <aside className="relative z-50 h-16 bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-screen">
        <div className="flex h-full items-center gap-2 px-3 md:flex-col md:gap-[18px] md:px-3 md:py-[22px]">
          <Link
            href="/home"
            aria-label={t("exploreAriaLabel")}
            className="grid size-11 shrink-0 place-items-center rounded-2xl border border-[#72c8bd] bg-[#0b5264] font-black tracking-[-0.08em] text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar-ring/50 md:size-[46px]"
          >
            {t("brandGlyph")}
          </Link>

          <nav className="flex gap-1 md:mt-3 md:flex-col md:gap-[9px]" aria-label={t("primaryNavAriaLabel")}>
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
                    "grid size-11 place-items-center rounded-[14px] text-[#bde1db] transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar-ring/50 md:size-12",
                    active
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  <Icon aria-hidden="true" className="size-5" />
                  <span className="sr-only">{label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2 md:ml-0 md:mt-auto md:flex-col">
            <LocaleSwitcher />
            <button
              type="button"
              title={t("accountAriaLabel")}
              aria-label={t("accountAriaLabel")}
              className="grid size-11 place-items-center rounded-full border-2 border-[#9ce0d4] bg-[#0b5264] text-sidebar-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar-ring/50"
            >
              <ListChecks aria-hidden="true" className="size-5" />
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0">{children}</div>
    </div>
  );
}