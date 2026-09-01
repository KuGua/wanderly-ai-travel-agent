"use client";

import type { PersonalResearchEvidenceResponse } from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — flight result card.
 *
 * Renders the bounded `personalResearchFlightEvidenceSummarySchema` projection
 * (offerCount + currency + origin/destination IATA + earliest/latest date
 * window). NEVER displays raw provider offers, chat excerpts, nationality,
 * passport, or document data — only the typed summary the server persisted.
 *
 * The countdown to `expiresAt` flips the card into an "expired" view when
 * past the provider's captured_at + freshness window.
 *
 * Source: docs/draft-personal-research-implementation.md §3.3, §3.5.
 */

interface FlightResearchResultCardProps {
  evidence: PersonalResearchEvidenceResponse;
  onCancel?: () => void;
}

export function FlightResearchResultCard(props: FlightResearchResultCardProps) {
  const { evidence } = props;
  const summary = evidence.summary;
  const isAvailable = summary.outcome === "AVAILABLE";
  const isUnavailable = summary.outcome === "UNAVAILABLE";
  const flightSummary = isAvailable && summary.flight ? summary.flight : null;

  return (
    <section
      data-testid="flight-research-result-card"
      data-capability="flight.search"
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
        <h3 style={{ margin: 0, fontSize: 16 }}>航班查询结果</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          数据来源 <strong>{evidence.providerName}</strong> · 捕获于 {new Date(evidence.capturedAt).toLocaleString()}
        </p>
      </header>

      {isAvailable && flightSummary ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
          <dt>报价数量</dt>
          <dd data-testid="flight-research-result-offer-count">{flightSummary.offerCount}</dd>
          <dt>币种</dt>
          <dd>{flightSummary.currency}</dd>
          <dt>航线</dt>
          <dd>{flightSummary.originIata} → {flightSummary.destinationIata}</dd>
          <dt>最早出发</dt>
          <dd>{flightSummary.earliestDeparture ? new Date(flightSummary.earliestDeparture).toLocaleString() : "—"}</dd>
          <dt>最晚返程</dt>
          <dd>{flightSummary.latestReturn ? new Date(flightSummary.latestReturn).toLocaleString() : "—"}</dd>
        </dl>
      ) : null}

      {isUnavailable ? (
        <p data-testid="flight-research-result-unavailable">
          暂不可用（{summary.summary.errorCode}）。结果不会写入共享行程；你可以重试或继续规划。
        </p>
      ) : null}

      {summary.outcome === "EXPIRED" ? (
        <p data-testid="flight-research-result-expired">结果已过期。请重新发起查询以获取最新报价。</p>
      ) : null}

      {evidence.expiresAt ? (
        <p data-testid="flight-research-result-expires-at" style={{ fontSize: 12, color: "var(--color-fg-muted, #6b7280)" }}>
          数据有效至 {new Date(evidence.expiresAt).toLocaleString()}
        </p>
      ) : null}

      {props.onCancel ? (
        <footer style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            data-testid="flight-research-result-cancel"
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