"use client";

import { ListChecks, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const navigation = [
  { href: "/home", label: "My program", icon: ListChecks },
  { href: "/profile", label: "Travel preference", icon: UserRound },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[5.5rem_minmax(0,1fr)]">
      <aside className="relative z-50 h-16 bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-screen">
        <div className="flex h-full items-center gap-2 px-3 md:flex-col md:gap-[18px] md:px-3 md:py-[22px]">
          <Link
            href="/home"
            aria-label="Wanderly Explore"
            className="grid size-11 shrink-0 place-items-center rounded-2xl border border-[#72c8bd] bg-[#0b5264] font-black tracking-[-0.08em] text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar-ring/50 md:size-[46px]"
          >
            W.
          </Link>

          <nav className="flex gap-1 md:mt-3 md:flex-col md:gap-[9px]" aria-label="Primary navigation">
            {navigation.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || (href === "/home" && pathname.startsWith("/trips/"));
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

          <button
            type="button"
            title="Account sign-in will connect here"
            aria-label="Account sign-in will connect here"
            className="ml-auto grid size-11 place-items-center rounded-full border-2 border-[#9ce0d4] bg-[#0b5264] text-sidebar-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar-ring/50 md:mt-auto md:ml-0"
          >
            <UserRound aria-hidden="true" className="size-5" />
          </button>
        </div>
      </aside>

      <div className="min-w-0">{children}</div>
    </div>
  );
}
