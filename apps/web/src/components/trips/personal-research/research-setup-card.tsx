import type { ReactNode } from "react";

import {
  type PersonalResearchMissingCode,
  type PersonalResearchReadiness,
  MISSING_COPY,
  renderReadinessHeadline,
} from "@/lib/trips/personal-research-readiness-copy";

/**
 * Personal Research Intent — setup-needed card (Phase 2).
 *
 * Renders when a classifier-extracted draft carries `readiness =
 * "NEEDS_SETUP"` (i.e. one or more server-owned Trip / preferences /
 * authorization fields must be configured before the owner can confirm).
 * The card is non-interactive: it explains the gap, lists the affected
 * config areas, and never auto-redirects.
 *
 * SPEC invariant: this card never echoes the original chat question,
 * place names, or provider raw data. Every label is the bounded
 * `MISSING_COPY` table.
 */
export function ResearchSetupCard({
  readiness,
  missing,
  intent,
  onDismiss,
}: {
  readiness: PersonalResearchReadiness;
  missing: PersonalResearchMissingCode[];
  intent: { kind: "RESEARCH_ONLY" | "PROPOSE_PLAN"; requestedCapabilities: string[] };
  onDismiss: () => void;
}): ReactNode {
  const headline = renderReadinessHeadline(readiness);
  return (
    <div
      data-testid="research-setup-card"
      data-readiness={readiness}
      className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="mb-2 font-medium">{headline.headline}</p>
      <p className="mb-2 text-xs">{headline.body}</p>
      <p className="mb-2 text-xs text-muted-foreground">
        模式：{intent.kind === "PROPOSE_PLAN" ? "研究 + 自动生成方案" : "仅研究"}
      </p>
      <ul className="mb-3 space-y-2">
        {missing.map((code) => {
          const copy = MISSING_COPY[code];
          return (
            <li key={code} className="rounded-md border border-amber-200 bg-white p-2">
              <p className="text-xs font-medium">{copy.title}</p>
              <p className="text-xs text-muted-foreground">{copy.detail}</p>
              <p className="mt-1 text-xs italic text-muted-foreground">
                {copy.ctaHint}
              </p>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-11 rounded-full border border-amber-300 px-3 text-xs font-bold text-amber-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30"
        >
          关闭
        </button>
      </div>
    </div>
  );
}
