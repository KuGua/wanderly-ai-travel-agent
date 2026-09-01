"use client";

import type { PersonalResearchEvidenceResponse } from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — navigation route result card (§3.5 stage 3).
 *
 * Renders the bounded `personalResearchNavigationRouteEvidenceSummarySchema`
 * projection: distance, duration and mode. Deliberately no fares and no
 * schedules — a road route says nothing about what a commercial service
 * charges, and deriving one from it is exactly what stage 3 forbids.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface NavigationResearchResultCardProps {
  evidence: PersonalResearchEvidenceResponse;
  onCancel?: () => void;
}

const MODE_LABEL: Record<string, string> = {
  driving: "驾车",
  walking: "步行",
  cycling: "骑行",
};

export function NavigationResearchResultCard(props: NavigationResearchResultCardProps) {
  const { evidence } = props;
  const summary = evidence.summary;
  const isAvailable = summary.outcome === "AVAILABLE";
  const isUnavailable = summary.outcome === "UNAVAILABLE";
  const route = isAvailable && summary.navigation ? summary.navigation : null;

  return (
    <section
      data-testid="navigation-research-result-card"
      data-capability="navigation.route"
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
        <h3 style={{ margin: 0, fontSize: 16 }}>路线查询结果</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          数据来源 <strong>{evidence.providerName}</strong> · 捕获于 {new Date(evidence.capturedAt).toLocaleString()}
        </p>
      </header>

      {isAvailable && route ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
          <dt>距离</dt>
          <dd data-testid="navigation-research-result-distance">{formatDistance(route.distanceMeters)}</dd>
          <dt>时长</dt>
          <dd data-testid="navigation-research-result-duration">{formatDuration(route.durationSeconds)}</dd>
          <dt>方式</dt>
          <dd>{MODE_LABEL[route.mode] ?? route.mode}</dd>
        </dl>
      ) : null}

      {isUnavailable ? (
        <p data-testid="navigation-research-result-unavailable">
          暂不可用（{summary.summary.errorCode}）。结果未写入共享行程；你可以重试或继续规划。
        </p>
      ) : null}

      {summary.outcome === "EXPIRED" ? (
        <p data-testid="navigation-research-result-expired">结果已过期。请重新发起查询。</p>
      ) : null}

      {evidence.expiresAt ? (
        <p data-testid="navigation-research-result-expires-at" style={{ fontSize: 12, color: "var(--color-fg-muted, #6b7280)" }}>
          数据有效至 {new Date(evidence.expiresAt).toLocaleString()}
        </p>
      ) : null}

      {props.onCancel ? (
        <footer style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            data-testid="navigation-research-result-cancel"
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

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} 公里` : `${Math.round(meters)} 米`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
