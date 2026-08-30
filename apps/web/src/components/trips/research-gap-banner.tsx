"use client";

import { useTranslations } from "next-intl";
import type { ResearchResult, ServiceCapability, ServiceGap } from "@/lib/api/contracts";

/**
 * Phase 4 — non-blocking research summary banner.
 *
 * Renders a low-risk informational card summarizing capability gaps
 * returned by the planner. The banner never blocks the user from continuing;
 * its purpose is to make "we couldn't check this" explicit so the team can
 * decide whether to wait, retry, or supply a manual answer.
 */
export interface ResearchGapBannerProps {
  result: ResearchResult | null;
  busy?: boolean;
}

const CAPABILITY_PRIORITY: ServiceCapability[] = [
  "flight",
  "stay",
  "hotel",
  "accommodation",
  "activities",
  "navigation",
  "mobility",
  "transit",
];

export function ResearchGapBanner({ result, busy = false }: ResearchGapBannerProps) {
  const t = useTranslations("trips.workspace.gaps");
  if (!result) return null;
  if (result.status === "COMPLETE") return null;
  const grouped = groupByCapability(result.serviceGaps);
  const sortedCapabilities = CAPABILITY_PRIORITY.filter((cap) => grouped[cap]?.length);
  return (
    <section
      className="wanderly-edge wanderly-r-md wanderly-shadow bg-amber-50 p-3 flex flex-col gap-2"
      role="status"
      aria-busy={busy}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <span className="text-xs text-amber-900">{t("badge")}</span>
      </header>
      <p className="text-xs text-amber-900">{t("body")}</p>
      <ul className="flex flex-col gap-1">
        {sortedCapabilities.map((cap) => (
          <li key={cap} className="text-xs">
            <b>{t(`capability.${cap}`)}:</b> {t("codeList", {
              codes: (grouped[cap] ?? []).map((g) => t(`code.${g.code}`)).join(", "),
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}

function groupByCapability(gaps: ReadonlyArray<ServiceGap>): Partial<Record<ServiceCapability, ServiceGap[]>> {
  const out: Partial<Record<ServiceCapability, ServiceGap[]>> = {};
  for (const gap of gaps) {
    if (!out[gap.capability]) out[gap.capability] = [];
    out[gap.capability]!.push(gap);
  }
  return out;
}
