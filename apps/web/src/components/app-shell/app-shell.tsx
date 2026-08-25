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

export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  const pathname = usePathname();

  // Strip the locale prefix before comparing to nav hrefs.
  const strippedPath = pathname.replace(/^\/(en|zh)/, "") || "/";

  return (
    <div className="min-h-screen bg-background landscape:grid landscape:grid-cols-[5.5rem_minmax(0,1fr)]">
      <aside className="relative z-50 h-16 bg-sidebar text-sidebar-foreground landscape:sticky landscape:top-0 landscape:h-screen">
        <div className="flex h-full items-center gap-2 px-3 landscape:flex-col landscape:gap-[18px] landscape:px-3 landscape:py-[22px]">
          <Link
            href="/home"
            aria-label={t("exploreAriaLabel")}
            className="grid size-11 shrink-0 place-items-center rounded-2xl border border-[#72c8bd] bg-[#0b5264] font-black tracking-[-0.08em] text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar-ring/50 landscape:size-[46px]"
          >
            {t("brandGlyph")}
          </Link>

          <nav className="flex gap-1 landscape:mt-3 landscape:flex-col landscape:gap-[9px]" aria-label={t("primaryNavAriaLabel")}>
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
                    "grid size-11 place-items-center rounded-[14px] text-[#bde1db] transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar-ring/50 landscape:size-12",
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

          <div className="ml-auto flex items-center gap-2 landscape:ml-0 landscape:mt-auto landscape:flex-col">
            <LocaleSwitcher />
            <AccountAuthControl />
          </div>
        </div>
      </aside>

      <div className="min-w-0">{children}</div>
    </div>
  );
}
