"use client";

import type { PersonalResearchEvidenceResponse } from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — hotel result card (§3.5 stage 2).
 *
 * Renders the bounded `personalResearchHotelEvidenceSummarySchema` projection
 * (propertyCount + currency + cityCode + check-in/out + min/max nightly
 * price). NEVER displays raw provider offers, chat excerpts, country of
 * the offer, passport, or document data — only the typed summary the
 * server persisted.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface HotelResearchResultCardProps {
  evidence: PersonalResearchEvidenceResponse;
  onCancel?: () => void;
}

export function HotelResearchResultCard(props: HotelResearchResultCardProps) {
  const { evidence } = props;
  const summary = evidence.summary;
  const isAvailable = summary.outcome === "AVAILABLE";
  const isUnavailable = summary.outcome === "UNAVAILABLE";
  const hotelSummary = isAvailable && summary.hotel ? summary.hotel : null;

  return (
    <section
      data-testid="hotel-research-result-card"
      data-capability="hotel.search"
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
        <h3 style={{ margin: 0, fontSize: 16 }}>酒店查询结果</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          数据来源 <strong>{evidence.providerName}</strong> · 捕获于 {new Date(evidence.capturedAt).toLocaleString()}
        </p>
      </header>

      {isAvailable && hotelSummary ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
          <dt>候选数量</dt>
          <dd data-testid="hotel-research-result-property-count">{hotelSummary.propertyCount}</dd>
          <dt>币种</dt>
          <dd>{hotelSummary.currency}</dd>
          <dt>城市</dt>
          <dd>{hotelSummary.cityCode}</dd>
          <dt>入住</dt>
          <dd>{hotelSummary.checkIn}</dd>
          <dt>退房</dt>
          <dd>{hotelSummary.checkOut}</dd>
          <dt>最低价 (晚)</dt>
          <dd>{hotelSummary.minNightlyPrice != null ? `${hotelSummary.minNightlyPrice} ${hotelSummary.currency}` : "—"}</dd>
          <dt>最高价 (晚)</dt>
          <dd>{hotelSummary.maxNightlyPrice != null ? `${hotelSummary.maxNightlyPrice} ${hotelSummary.currency}` : "—"}</dd>
        </dl>
      ) : null}

      {isUnavailable ? (
        <p data-testid="hotel-research-result-unavailable">
          暂不可用（{summary.summary.errorCode}）。结果未写入共享行程；你可以重试或继续规划。
        </p>
      ) : null}

      {summary.outcome === "EXPIRED" ? (
        <p data-testid="hotel-research-result-expired">结果已过期。请重新发起查询。</p>
      ) : null}

      {evidence.expiresAt ? (
        <p data-testid="hotel-research-result-expires-at" style={{ fontSize: 12, color: "var(--color-fg-muted, #6b7280)" }}>
          数据有效至 {new Date(evidence.expiresAt).toLocaleString()}
        </p>
      ) : null}

      {props.onCancel ? (
        <footer style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            data-testid="hotel-research-result-cancel"
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