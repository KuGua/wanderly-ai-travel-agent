"use client";

import type { PersonalResearchEvidenceResponse } from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — activities result card (§3.5 stage 2).
 *
 * Renders the bounded `personalResearchActivitiesEvidenceSummarySchema`
 * projection (activityCount + currency + destination + date range + a
 * min/max price band). The executor deliberately withholds per-activity
 * supplier, title, and booking URL so a Personal result can never seed
 * Shared plan evidence — this card shows the aggregate only and must not
 * grow per-offer fields.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface ActivitiesResearchResultCardProps {
  evidence: PersonalResearchEvidenceResponse;
  onCancel?: () => void;
}

export function ActivitiesResearchResultCard(props: ActivitiesResearchResultCardProps) {
  const { evidence } = props;
  const summary = evidence.summary;
  const isAvailable = summary.outcome === "AVAILABLE";
  const isUnavailable = summary.outcome === "UNAVAILABLE";
  const activitiesSummary = isAvailable && summary.activities ? summary.activities : null;

  // A band is only meaningful when the provider denominated it; an amount
  // without a currency is not a price, so it is withheld rather than guessed.
  const priceBand = activitiesSummary && activitiesSummary.currency
    && activitiesSummary.minPrice != null && activitiesSummary.maxPrice != null
    ? `${activitiesSummary.minPrice} – ${activitiesSummary.maxPrice} ${activitiesSummary.currency}`
    : null;

  return (
    <section
      data-testid="activities-research-result-card"
      data-capability="activities.search"
      data-outcome={evidence.outcome}
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: 12,
        padding: 16,
        display: "grid",
        gap: 8,
      }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 16 }}>活动查询结果</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          数据来源 <strong>{evidence.providerName}</strong> · 捕获于 {new Date(evidence.capturedAt).toLocaleString()}
        </p>
      </header>

      {isAvailable && activitiesSummary ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
          <dt>候选数量</dt>
          <dd data-testid="activities-research-result-activity-count">{activitiesSummary.activityCount}</dd>
          <dt>目的地</dt>
          <dd>{activitiesSummary.destinationCode}</dd>
          <dt>日期</dt>
          <dd>{activitiesSummary.startDate} – {activitiesSummary.endDate}</dd>
          <dt>价格区间</dt>
          <dd data-testid="activities-research-result-price-band">{priceBand ?? "—"}</dd>
        </dl>
      ) : null}

      {isUnavailable ? (
        <p data-testid="activities-research-result-unavailable">
          暂不可用（{summary.summary.errorCode}）。结果未写入共享行程；你可以重试或继续规划。
        </p>
      ) : null}

      {summary.outcome === "EXPIRED" ? (
        <p data-testid="activities-research-result-expired">结果已过期。请重新发起查询。</p>
      ) : null}

      {evidence.expiresAt ? (
        <p data-testid="activities-research-result-expires-at" style={{ fontSize: 12, color: "var(--color-fg-muted, #6b7280)" }}>
          数据有效至 {new Date(evidence.expiresAt).toLocaleString()}
        </p>
      ) : null}

      {props.onCancel ? (
        <footer style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            data-testid="activities-research-result-cancel"
            type="button"
            onClick={props.onCancel}
            style={{ padding: "6px 12px" }}
          >
            取消
          </button>
        </footer>
      ) : null}
    </section>
  );
}
