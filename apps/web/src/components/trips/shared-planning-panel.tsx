"use client";

import { Plane, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { useLatestPlan, useLatestPlanningRun, useStartPlanning } from "@/lib/query/hooks";

export function SharedPlanningPanel({ tripId, tripStatus }: { tripId: string; tripStatus: string }) {
  const t = useTranslations("trips.planning");
  const [tripType, setTripType] = useState<"ONE_WAY" | "ROUND_TRIP">("ROUND_TRIP");
  const [adults, setAdults] = useState(1);
  const [cabin, setCabin] = useState<"ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST">("ECONOMY");
  const [currency, setCurrency] = useState("USD");
  const startPlanning = useStartPlanning(tripId);
  const runQuery = useLatestPlanningRun(tripId);
  const run = runQuery.data?.run ?? null;
  const runHasPersistedPlan = run?.status === "COMPLETED" || run?.status === "COMPLETED_WITH_GAPS";
  const planQuery = useLatestPlan(tripId, runHasPersistedPlan || Boolean(run?.resultPlanId));
  const plan = planQuery.data?.plan ?? null;
  const tripIsActive = tripStatus !== "DRAFT";

  return (
    <section className="my-6 rounded-[22px] border bg-card p-5 shadow-[0_8px_24px_#102a4308]" aria-label={t("heading")}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.11em] text-primary"><Plane className="size-3.5" aria-hidden="true" /> {t("kicker")}</p>
          <h2 className="mt-1 text-xl font-bold tracking-[-0.04em]">{t("heading")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("body")}</p>
        </div>
        {run ? <RunBadge status={run.status} /> : null}
      </header>

      <form
        className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void startPlanning.mutateAsync({ tripType, adults, cabin, currency: currency.trim().toUpperCase(), offerFreshnessMinutes: 15 });
        }}
      >
        <label className="grid gap-1 text-xs font-bold text-muted-foreground">
          {t("tripType")}
          <select value={tripType} onChange={(event) => setTripType(event.target.value as typeof tripType)} className="min-h-10 rounded-[10px] border bg-background px-2 text-sm text-foreground">
            <option value="ROUND_TRIP">{t("roundTrip")}</option>
            <option value="ONE_WAY">{t("oneWay")}</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-bold text-muted-foreground">
          {t("adults")}
          <input type="number" min={1} max={9} value={adults} onChange={(event) => setAdults(Math.max(1, Math.min(9, Number(event.target.value) || 1)))} className="min-h-10 rounded-[10px] border bg-background px-2 text-sm text-foreground" />
        </label>
        <label className="grid gap-1 text-xs font-bold text-muted-foreground">
          {t("cabin")}
          <select value={cabin} onChange={(event) => setCabin(event.target.value as typeof cabin)} className="min-h-10 rounded-[10px] border bg-background px-2 text-sm text-foreground">
            <option value="ECONOMY">{t("cabinEconomy")}</option><option value="PREMIUM_ECONOMY">{t("cabinPremium")}</option><option value="BUSINESS">{t("cabinBusiness")}</option><option value="FIRST">{t("cabinFirst")}</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-bold text-muted-foreground">
          {t("currency")}
          <input value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} className="min-h-10 rounded-[10px] border bg-background px-2 text-sm uppercase text-foreground" />
        </label>
        <button type="submit" disabled={!tripIsActive || startPlanning.isPending || Boolean(run && ["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(run.status))} className="mt-auto inline-flex min-h-10 items-center justify-center gap-2 rounded-[10px] bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">
          <RefreshCw className={`size-3.5 ${startPlanning.isPending ? "animate-spin" : ""}`} aria-hidden="true" /> {t("start")}
        </button>
      </form>

      {!tripIsActive ? <p className="mt-3 text-sm text-muted-foreground">{t("draftBlocked")}</p> : null}
      {startPlanning.isError ? <p className="mt-3 rounded-[10px] bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">{t("startFailed")}</p> : null}
      {runQuery.isError ? <ErrorState error={runQuery.error} title={t("statusUnavailable")} /> : null}
      {run ? <p className="mt-3 text-sm text-muted-foreground">{t("status", { status: run.status })}{run.errorCode ? ` · ${t("failure", { code: run.errorCode })}` : ""}</p> : <p className="mt-3 text-sm text-muted-foreground">{t("noRun")}</p>}

      {planQuery.isPending ? <div className="mt-4"><LoadingState label={t("loadingPlan")} /></div> : null}
      {plan ? <div className="mt-5 border-t pt-4">
        <p className="inline-flex items-center gap-2 text-sm font-black"><ShieldCheck className="size-4 text-primary" aria-hidden="true" /> {t("activePlan", { destination: plan.planData.destination, version: plan.version })}</p>
        <ul className="mt-3 grid gap-2 md:grid-cols-2" aria-label={t("flightResults")}>
          {plan.planData.flights.map((flight) => <li key={flight.id} className="rounded-[12px] border bg-secondary/30 p-3 text-sm">
            <p className="font-bold">{flight.origin} → {flight.destination} · {flight.totalPrice} {flight.currency}</p>
            <p className="mt-1 text-muted-foreground">{flight.segments[0]?.departureAt} · {flight.cabin.replaceAll("_", " ")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{flight.source} · {t("captured", { capturedAt: flight.capturedAt })}</p>
          </li>)}
        </ul>
      </div> : null}
    </section>
  );
}

function RunBadge({ status }: { status: string }) {
  const t = useTranslations("trips.planning");
  const active = status === "QUEUED" || status === "RUNNING" || status === "CANCEL_REQUESTED";
  return <span className={`rounded-full px-3 py-1 text-xs font-black ${active ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground"}`}>{t("status", { status })}</span>;
}
