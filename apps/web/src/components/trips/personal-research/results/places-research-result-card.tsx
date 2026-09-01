"use client";

import type { PersonalResearchEvidenceResponse } from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — places result card (§3.5 stage 3).
 *
 * Renders the bounded `personalResearchPlacesEvidenceSummarySchema` projection
 * (candidateCount + categories + radius). NEVER displays coordinates,
 * raw provider offers, or anything that would seed the Shared `trip_places`
 * table. The owner must use the Shared adopt endpoint to make any
 * candidate addressable to other members.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface PlacesResearchResultCardProps {
  evidence: PersonalResearchEvidenceResponse;
  onCancel?: () => void;
}

export function PlacesResearchResultCard(props: PlacesResearchResultCardProps) {
  const { evidence } = props;
  const summary = evidence.summary;
  const isAvailable = summary.outcome === "AVAILABLE";
  const isUnavailable = summary.outcome === "UNAVAILABLE";
  const placesSummary = isAvailable && summary.places ? summary.places : null;

  return (
    <section
      data-testid="places-research-result-card"
      data-capability="places.search"
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
        <h3 style={{ margin: 0, fontSize: 16 }}>地点查询结果</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          数据来源 <strong>{evidence.providerName}</strong> · 捕获于 {new Date(evidence.capturedAt).toLocaleString()}
        </p>
      </header>

      {isAvailable && placesSummary ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
          <dt>候选数量</dt>
          <dd data-testid="places-research-result-candidate-count">{placesSummary.candidateCount}</dd>
          <dt>类别</dt>
          <dd>{placesSummary.categories.length > 0 ? placesSummary.categories.join(", ") : "—"}</dd>
          <dt>搜索半径</dt>
          <dd>{placesSummary.radiusMeters} 米</dd>
        </dl>
      ) : null}

      {isUnavailable ? (
        <p data-testid="places-research-result-unavailable">
          暂不可用（{summary.summary.errorCode}）。结果未写入共享行程；可稍后重试或继续规划。
        </p>
      ) : null}

      {summary.outcome === "EXPIRED" ? (
        <p data-testid="places-research-result-expired">结果已过期。请重新发起查询。</p>
      ) : null}

      {evidence.expiresAt ? (
        <p data-testid="places-research-result-expires-at" style={{ fontSize: 12, color: "var(--color-fg-muted, #6b7280)" }}>
          数据有效至 {new Date(evidence.expiresAt).toLocaleString()}
        </p>
      ) : null}

      {props.onCancel ? (
        <footer style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            data-testid="places-research-result-cancel"
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