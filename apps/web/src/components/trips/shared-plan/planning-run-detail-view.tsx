"use client";

import { useLocale } from "next-intl";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link } from "@/i18n/navigation";
import { useTripPlanningRunDetail } from "@/lib/query/hooks";

const gapLabels: Record<string, Record<string, string>> = {
  en: {
    NO_RESULTS: "No verified results were returned.",
    UPSTREAM_FAILURE: "The provider was temporarily unavailable.",
    UPSTREAM_TIMEOUT: "The provider request timed out.",
    NOT_CONFIGURED: "This provider is not configured.",
  },
  zh: {
    NO_RESULTS: "未返回可验证的结果。",
    UPSTREAM_FAILURE: "服务提供方暂时不可用。",
    UPSTREAM_TIMEOUT: "服务提供方请求超时。",
    NOT_CONFIGURED: "该服务提供方尚未配置。",
  },
};

/**
 * Safe read-only outcome for one shared planning run. It is deliberately not
 * a plan renderer: a run with gaps and no `resultPlanId` must explain that
 * no itinerary was produced instead of making the research summary look like
 * a usable Shared plan.
 */
export function PlanningRunDetailView({ tripId, runId }: { tripId: string; runId: string }) {
  const locale = useLocale() === "zh" ? "zh" : "en";
  const detail = useTripPlanningRunDetail(tripId, runId);

  if (detail.isLoading) return <LoadingState label={locale === "zh" ? "正在读取规划结果…" : "Loading planning result…"} />;
  if (detail.error || !detail.data) {
    return <ErrorState error={detail.error ?? new Error("Planning run not found")} title={locale === "zh" ? "无法读取规划结果" : "Unable to load planning result"} />;
  }

  const { run, research } = detail.data;
  const hasPlan = Boolean(run.resultPlanId ?? research?.resultPlanId);
  const title = hasPlan
    ? (locale === "zh" ? "共享方案已生成" : "Shared plan generated")
    : (locale === "zh" ? "本次规划未生成共享方案" : "This run did not generate a shared plan");

  return (
    <main className="mx-auto max-w-3xl px-4 py-8" aria-labelledby="planning-run-title">
      <Link href={`/trips/${tripId}?view=shared`} className="text-sm font-semibold text-sky-700 hover:underline">
        {locale === "zh" ? "← 返回共享方案" : "← Back to shared plan"}
      </Link>
      <section className="mt-4 rounded-2xl border border-slate-200 bg-card p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {locale === "zh" ? "共享规划运行" : "Shared planning run"}
        </p>
        <h1 id="planning-run-title" className="mt-2 text-2xl font-bold text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {hasPlan
            ? (locale === "zh" ? "该运行已生成可在共享方案中查看的计划版本。" : "This run produced a plan version visible in Shared plan.")
            : (locale === "zh" ? "实时数据未满足生成计划的条件；系统没有创建不可靠的行程。" : "Live data did not meet the threshold for a plan, so no unreliable itinerary was created.")}
        </p>
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-slate-500">{locale === "zh" ? "状态" : "Status"}</dt><dd className="font-semibold text-slate-900">{run.status}</dd></div>
          <div><dt className="text-slate-500">{locale === "zh" ? "完成时间" : "Finished"}</dt><dd className="font-semibold text-slate-900">{run.finishedAt ? new Date(run.finishedAt).toLocaleString(locale) : "—"}</dd></div>
        </dl>
        {!hasPlan && research?.serviceGaps.length ? (
          <div className="mt-6 border-t border-slate-200 pt-5">
            <h2 className="font-bold text-slate-900">{locale === "zh" ? "未生成方案的原因" : "Why a plan was not generated"}</h2>
            <ul className="mt-3 grid gap-2" aria-label={locale === "zh" ? "服务数据缺口" : "Service data gaps"}>
              {research.serviceGaps.map((gap, index) => (
                <li key={`${gap.capability}-${gap.code}-${index}`} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  <span className="font-semibold">{gap.capability}</span>{": "}{gapLabels[locale][gap.code] ?? gap.code}
                  {gap.destinationId ? ` (${gap.destinationId})` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </main>
  );
}
