"use client";

/**
 * PinnedResultCard — Renders the latest server-managed pinned agent
 * run at the top of the trip detail. Surfaces destination, dates,
 * status, and a link to the run's full evidence / plan card.
 *
 * Server-managed pin means the owner never has to manually pick which
 * run to view — `shared_trips.pinned_session_id` always points to the
 * latest terminal run written by either `pinSessionIfAbsent` (confirm
 * path) or `pinSessionIfTerminal` (orchestrator terminal events). The
 * card is read-only in MVP: no manual pin / unpin UI.
 */

// The locale-aware Link, not `next/link`. Routing is `localePrefix: "always"`,
// so a bare `/trips/...` href has no locale segment: the middleware has to
// redirect, and a reader whose locale is not the default can land on the
// default-locale copy of the page they clicked from. The sibling entry point
// in shared-plan-view.tsx already emits `/zh/trips/...`; this one did not.
import { Link } from "@/i18n/navigation";
import type { FC } from "react";

import type { TripPinnedSession } from "@/lib/api/contracts";

interface PinnedResultCardProps {
  tripId: string;
  pinned: TripPinnedSession;
}

const statusLabel: Record<TripPinnedSession["status"], string> = {
  QUEUED: "排队中",
  RUNNING: "运行中",
  CANCEL_REQUESTED: "已请求取消",
  COMPLETED: "已完成",
  COMPLETED_WITH_GAPS: "已完成（部分缺失）",
  FAILED: "失败",
  CANCELLED: "已取消",
  STALE: "已失效",
};

const statusTone: Record<TripPinnedSession["status"], string> = {
  QUEUED: "bg-muted text-slate-700 border-slate-200",
  RUNNING: "bg-sky-100 text-sky-800 border-sky-200",
  CANCEL_REQUESTED: "bg-amber-100 text-amber-800 border-amber-200",
  COMPLETED: "bg-emerald-100 text-emerald-800 border-emerald-200",
  COMPLETED_WITH_GAPS: "bg-amber-100 text-amber-900 border-amber-200",
  FAILED: "bg-rose-100 text-rose-800 border-rose-200",
  CANCELLED: "bg-muted text-slate-700 border-slate-200",
  STALE: "bg-muted text-slate-700 border-slate-200",
};

const operationLabel: Record<TripPinnedSession["operation"], string> = {
  CONVERSATION: "对话",
  PLAN: "行程规划",
  REPLAN: "重新规划",
  RESEARCH: "研究",
};

export const PinnedResultCard: FC<PinnedResultCardProps> = ({ tripId, pinned }) => {
  const destinations = pinned.destinationCandidates.slice(0, 3).join("、");
  const destOverflow = pinned.destinationCandidates.length > 3
    ? ` 等 ${pinned.destinationCandidates.length} 个`
    : "";
  return (
    <div
      className="rounded-xl border border-slate-200 bg-card p-4 shadow-sm"
      data-testid="pinned-result-card"
      data-run-id={pinned.agentTaskRunId}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
            {operationLabel[pinned.operation]} · 置顶结果
          </div>
          <div className="mt-1 text-base font-semibold text-slate-900">
            {destinations || "未指定目的地"}{destOverflow}
          </div>
          {pinned.travelDays != null && (
            <div className="mt-1 text-xs text-slate-500">
              {pinned.travelDays} 天行程
            </div>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone[pinned.status]}`}
        >
          {statusLabel[pinned.status]}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
        <time dateTime={pinned.pinnedAt}>
          置顶于 {new Date(pinned.pinnedAt).toLocaleString()}
        </time>
        <Link
          className="font-medium text-sky-700 hover:underline"
          href={`/trips/${tripId}/runs/${pinned.agentTaskRunId}`}
        >
          查看详情 →
        </Link>
      </div>
    </div>
  );
};