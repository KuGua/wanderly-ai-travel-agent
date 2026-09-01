"use client";

import type { PersonalResearchEvidenceResponse } from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — accommodation discovery result card (§3.5 stage 2).
 *
 * Renders the bounded `personalResearchAccommodationEvidenceSummarySchema`
 * projection: how many candidates were found in the radius, the dominant
 * category, and the stay window. Discovery deliberately carries no price —
 * OpenTripMap does not quote rooms — so this card must never grow a price
 * field. Rates come from `hotel.search` and its own card.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface AccommodationResearchResultCardProps {
  evidence: PersonalResearchEvidenceResponse;
  onCancel?: () => void;
}

export function AccommodationResearchResultCard(props: AccommodationResearchResultCardProps) {
  const { evidence } = props;
  const summary = evidence.summary;
  const isAvailable = summary.outcome === "AVAILABLE";
  const isUnavailable = summary.outcome === "UNAVAILABLE";
  const stay = isAvailable && summary.accommodation ? summary.accommodation : null;

  return (
    <section
      data-testid="accommodation-research-result-card"
      data-capability="accommodation.discovery"
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
        <h3 style={{ margin: 0, fontSize: 16 }}>周边住宿查询结果</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          数据来源 <strong>{evidence.providerName}</strong> · 捕获于 {new Date(evidence.capturedAt).toLocaleString()}
        </p>
      </header>

      {isAvailable && stay ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
          <dt>候选数量</dt>
          <dd data-testid="accommodation-research-result-candidate-count">{stay.candidateCount}</dd>
          <dt>主要类型</dt>
          <dd>{stay.topCategory ?? "—"}</dd>
          <dt>搜索半径</dt>
          <dd>{stay.radiusMeters} 米</dd>
          <dt>入住</dt>
          <dd>{stay.checkIn}</dd>
          <dt>退房</dt>
          <dd>{stay.checkOut}</dd>
        </dl>
      ) : null}

      {isAvailable && stay ? (
        <p style={{ fontSize: 12, color: "var(--color-fg-muted, #6b7280)", margin: 0 }}>
          此结果不含房价。需要报价请发起酒店查询。
        </p>
      ) : null}

      {isUnavailable ? (
        <p data-testid="accommodation-research-result-unavailable">
          暂不可用（{summary.summary.errorCode}）。结果未写入共享行程；你可以重试或继续规划。
        </p>
      ) : null}

      {summary.outcome === "EXPIRED" ? (
        <p data-testid="accommodation-research-result-expired">结果已过期。请重新发起查询。</p>
      ) : null}

      {evidence.expiresAt ? (
        <p data-testid="accommodation-research-result-expires-at" style={{ fontSize: 12, color: "var(--color-fg-muted, #6b7280)" }}>
          数据有效至 {new Date(evidence.expiresAt).toLocaleString()}
        </p>
      ) : null}

      {props.onCancel ? (
        <footer style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            data-testid="accommodation-research-result-cancel"
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
