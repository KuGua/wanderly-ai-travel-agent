"use client";

import { useTranslations } from "next-intl";

import type { ListedPlan } from "@/lib/api/contracts";
import {
  useCastAdoptionVote,
  usePlanAdoptionVotes,
} from "@/lib/query/hooks";

/**
 * Shared Plan Surface — Phase 3 proposal card.
 *
 * One card per destination (§7.3 of
 * docs/shared-plan-surface-implementation.md). The props surface
 * deliberately accepts only the redacted shape — `ListedPlan[]` and
 * `teamVisibleFacts` — so the rendering tree cannot reach the owner-only
 * data sources the spec forbids: researchIntentDraft, pendingBriefProposal,
 * tripBriefProposal, constraintsOwner, chat_messages (§1.4 / §10.2.15).
 *
 * The voting block appears only on PROPOSED plans. ACTIVE / STALE / others
 * are read-only.
 */

type VoteTally = {
  votesAccepted: number;
  votesRequired: number;
  hasBlocker: boolean;
  currentUserDecision: "ACCEPT" | "NEEDS_CHANGES" | null;
};

type FlightOffer = {
  origin?: string;
  destination?: string;
  cabin?: string;
  totalPrice?: number;
  currency?: string;
  source?: string;
  capturedAt?: string;
  expiresAt?: string;
  segments?: Array<{
    origin?: string;
    destination?: string;
    departureAt?: string;
    arrivalAt?: string;
    carrier?: string;
    flightNumber?: string;
  }>;
};

type StayOffer = {
  name?: string;
  cityName?: string;
  nightlyPrice?: number;
  totalPrice?: number;
  currency?: string;
  source?: string;
  capturedAt?: string;
  expiresAt?: string;
};

type HotelOffer = StayOffer;

type ActivityEvidence = {
  name?: string;
  cityName?: string;
  source?: string;
  capturedAt?: string;
};

type PlanPayload = {
  destination?: string;
  flights?: FlightOffer[];
  stays?: StayOffer[];
  hotels?: HotelOffer[];
  activities?: ActivityEvidence[];
  constraintReferences?: string[];
  publicExplanationTokens?: string[];
  generatedAt?: string;
};

export function PlanProposalCard({ plan, tripId }: { plan: ListedPlan; tripId: string }) {
  const t = useTranslations("trips.sharedPlan.plan");
  const payload = readPlanPayload(plan.planData);

  return (
    <article
      data-testid={`plan-proposal-card-${plan.id}`}
      data-status={plan.status}
      data-version={plan.version}
      aria-label={plan.destination}
      className="flex flex-col gap-3 bg-card p-4 wanderly-edge wanderly-r-md wanderly-shadow"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-extrabold tracking-tight">{plan.destination}</h3>
        <span className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-extrabold wanderly-edge-thin wanderly-r-xs ${STATUS_BADGE[plan.status]}`}>
          {t(`statusBadge.${plan.status}`)}
        </span>
      </header>
      <p className="text-[11px] text-muted-foreground">
        {t("version", { value: plan.version })} · {t("generatedAt", { value: formatTimestamp(plan.generatedAt) })}
      </p>

      <FlightsSection payload={payload} />
      <StaysSection payload={payload} />
      <ActivitiesSection payload={payload} />
      <ExplanationSection tokens={payload.publicExplanationTokens} />
      <ConstraintCount count={payload.constraintReferences?.length ?? 0} />

      {plan.status === "PROPOSED" ? <VoteBlock planId={plan.id} tripId={tripId} /> : null}
    </article>
  );
}

function FlightsSection({ payload }: { payload: PlanPayload }) {
  const t = useTranslations("trips.sharedPlan.plan");
  if (!payload.flights || payload.flights.length === 0) {
    return <Section title={t("flights")} unavailable />;
  }
  // Group flights by origin so a multi-leg booking reads as two offers,
  // not eight. A missing origin lands under a synthetic bucket so the row
  // is still rendered.
  const grouped = new Map<string, FlightOffer[]>();
  for (const flight of payload.flights) {
    const key = flight.origin ?? "—";
    const list = grouped.get(key) ?? [];
    list.push(flight);
    grouped.set(key, list);
  }
  return (
    <section aria-label={t("flights")} className="grid gap-2">
      <p className="text-xs font-bold">{t("flights")}</p>
      <ul className="grid gap-2">
        {Array.from(grouped.entries()).map(([origin, offers]) => (
          <li key={origin} className="bg-[var(--w-mist)] p-2 text-[12px] wanderly-edge-thin wanderly-r-xs">
            <p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground">
              {origin}
            </p>
            {offers.map((offer, idx) => (
              <FlightLine key={idx} offer={offer} />
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

function FlightLine({ offer }: { offer: FlightOffer }) {
  const t = useTranslations("trips.sharedPlan.plan");
  const priceLabel = formatPrice(offer.totalPrice, offer.currency);
  const segments = offer.segments?.map((s) => `${s.carrier ?? ""}${s.flightNumber ?? ""} ${s.origin ?? ""}→${s.destination ?? ""}`).join(" · ");
  const expired = isExpired(offer.expiresAt);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-mono text-[12px]">{offer.origin ?? "?"} → {offer.destination ?? "?"}</span>
      {segments ? <span className="text-[11px] text-muted-foreground">{segments}</span> : null}
      <span className="ml-auto text-[12px] font-bold">{priceLabel}</span>
      <span className="text-[10px] text-muted-foreground">{offer.source ?? "—"} · {formatTimestamp(offer.capturedAt)}</span>
      {expired ? (
        <span role="status" className="ml-1 inline-flex items-center bg-destructive/15 px-1.5 py-0.5 text-[10px] font-bold text-destructive wanderly-edge-thin wanderly-r-xs">
          {t("offerExpired")}
        </span>
      ) : null}
    </div>
  );
}

function StaysSection({ payload }: { payload: PlanPayload }) {
  const t = useTranslations("trips.sharedPlan.plan");
  // Spec §4.2: schema permits both `stays` and `hotels`; render whichever
  // is non-empty. Empty array on either means "no offer was collected".
  const stays = payload.stays ?? [];
  const hotels = payload.hotels ?? [];
  if (stays.length === 0 && hotels.length === 0) {
    return (
      <>
        <Section title={t("stays")} unavailable>
          <></>
        </Section>
        <Section title={t("hotels")} unavailable>
          <></>
        </Section>
      </>
    );
  }
  return (
    <>
      {stays.length > 0 ? (
        <Section title={t("stays")}>
          <ul className="grid gap-1">
            {stays.map((stay) => <StayLine key={stay.name ?? stay.cityName ?? "stay"} offer={stay} />)}
          </ul>
        </Section>
      ) : null}
      {hotels.length > 0 ? (
        <Section title={t("hotels")}>
          <ul className="grid gap-1">
            {hotels.map((hotel) => <StayLine key={hotel.name ?? hotel.cityName ?? "hotel"} offer={hotel} />)}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

function StayLine({ offer }: { offer: StayOffer | HotelOffer }) {
  const t = useTranslations("trips.sharedPlan.plan");
  const priceLabel = formatPrice(offer.totalPrice ?? offer.nightlyPrice, offer.currency);
  const expired = isExpired(offer.expiresAt);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
      <span className="font-bold">{offer.name ?? offer.cityName ?? "—"}</span>
      <span className="ml-auto font-bold">{priceLabel}</span>
      <span className="text-[10px] text-muted-foreground">{offer.source ?? "—"} · {formatTimestamp(offer.capturedAt)}</span>
      {expired ? (
        <span role="status" className="ml-1 inline-flex items-center bg-destructive/15 px-1.5 py-0.5 text-[10px] font-bold text-destructive wanderly-edge-thin wanderly-r-xs">
          {t("offerExpired")}
        </span>
      ) : null}
    </li>
  );
}

function ActivitiesSection({ payload }: { payload: PlanPayload }) {
  const t = useTranslations("trips.sharedPlan.plan");
  if (!payload.activities || payload.activities.length === 0) {
    return <Section title={t("activities")} unavailable />;
  }
  return (
    <Section title={t("activities")}>
      <ul className="grid gap-1 text-[12px]">
        {payload.activities.map((act) => (
          <li key={act.name ?? act.cityName ?? "activity"} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-bold">{act.name ?? act.cityName ?? "—"}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">{act.source ?? "—"} · {formatTimestamp(act.capturedAt)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ExplanationSection({ tokens }: { tokens: string[] | undefined }) {
  const t = useTranslations("trips.sharedPlan.plan.explanation");
  // Unknown tokens are silently dropped (§7.4) — surfacing the raw token
  // would leak server-internal identifiers to the UI.
  if (!tokens || tokens.length === 0) return null;
  return (
    <ul aria-label="Public explanation" className="grid gap-1">
      {tokens.map((token) => (
        <li key={token} className="text-[11px] text-muted-foreground">
          {/* `t.exists()` would be the right call but next-intl falls back
              to the key string when missing — same UX, fewer helpers. */}
          {t(token as Parameters<typeof t>[0])}
        </li>
      ))}
    </ul>
  );
}

function ConstraintCount({ count }: { count: number }) {
  const t = useTranslations("trips.sharedPlan.plan");
  if (count === 0) return null;
  return (
    <p className="text-[11px] text-muted-foreground">
      {t("constraintCount", { count })}
    </p>
  );
}

function Section({ title, unavailable, children }: { title: string; unavailable?: boolean; children?: React.ReactNode }) {
  const t = useTranslations("trips.sharedPlan.plan");
  return (
    <section aria-label={title} className="grid gap-2">
      <p className="text-xs font-bold">{title}</p>
      {unavailable ? (
        <p className="bg-[var(--w-mist)] p-2 text-[12px] text-muted-foreground wanderly-edge-thin wanderly-r-xs">
          {t("unavailable")}
        </p>
      ) : children}
    </section>
  );
}

function VoteBlock({ planId, tripId }: { planId: string; tripId: string }) {
  const t = useTranslations("trips.sharedPlan.vote");
  const votesQuery = usePlanAdoptionVotes(planId);
  const cast = useCastAdoptionVote(tripId);
  const tally: VoteTally = votesQuery.data
    ? {
        votesAccepted: votesQuery.data.votesAccepted,
        votesRequired: votesQuery.data.votesRequired,
        hasBlocker: votesQuery.data.hasBlocker,
        currentUserDecision: votesQuery.data.currentUserDecision,
      }
    : { votesAccepted: 0, votesRequired: 0, hasBlocker: false, currentUserDecision: null };
  return (
    <div data-testid={`plan-vote-block-${planId}`} className="grid gap-2 border-t-2 border-[var(--w-ink)] pt-2">
      <p className="text-[11px] text-muted-foreground">
        {t("tally", { accepted: tally.votesAccepted, required: tally.votesRequired })}
        {tally.hasBlocker ? ` · ${t("blocked")}` : ""}
      </p>
      <p className="text-[11px] text-muted-foreground">{t("notBooking")} · {t("noRestore")}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={cast.isPending}
          onClick={() => cast.mutate({ planId, input: { decision: "ACCEPT" } })}
          aria-pressed={tally.currentUserDecision === "ACCEPT"}
          className="min-h-10 px-3 text-xs font-extrabold wanderly-edge wanderly-r-xs wanderly-shadow-xs wanderly-press wanderly-action"
        >
          {t("accept")}
        </button>
        <button
          type="button"
          disabled={cast.isPending}
          onClick={() => cast.mutate({ planId, input: { decision: "NEEDS_CHANGES" } })}
          aria-pressed={tally.currentUserDecision === "NEEDS_CHANGES"}
          className="min-h-10 bg-[var(--w-mist)] px-3 text-xs font-extrabold text-[var(--w-ink)] wanderly-edge wanderly-r-xs wanderly-press"
        >
          {t("needsChanges")}
        </button>
      </div>
      {cast.isError ? (
        <p role="alert" className="text-[11px] text-destructive">
          {t("error", { message: (cast.error as Error)?.message ?? "—" })}
        </p>
      ) : null}
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * The wire shape of `planData` is `Record<string, unknown>`. The
 * validator on the server already enforces the schema; this reader
 * just narrows each field defensively so a future server-side schema
 * loosening doesn't quietly surface raw objects.
 */
function readPlanPayload(raw: Record<string, unknown>): PlanPayload {
  const out: PlanPayload = {};
  if (typeof raw.destination === "string") out.destination = raw.destination;
  if (Array.isArray(raw.flights)) {
    out.flights = raw.flights.filter((entry): entry is FlightOffer => typeof entry === "object" && entry !== null);
  }
  if (Array.isArray(raw.stays)) {
    out.stays = raw.stays.filter((entry): entry is StayOffer => typeof entry === "object" && entry !== null);
  }
  if (Array.isArray(raw.hotels)) {
    out.hotels = raw.hotels.filter((entry): entry is HotelOffer => typeof entry === "object" && entry !== null);
  }
  if (Array.isArray(raw.activities)) {
    out.activities = raw.activities.filter((entry): entry is ActivityEvidence => typeof entry === "object" && entry !== null);
  }
  if (Array.isArray(raw.constraintReferences)) {
    out.constraintReferences = raw.constraintReferences.filter((ref): ref is string => typeof ref === "string");
  }
  if (Array.isArray(raw.publicExplanationTokens)) {
    // §4.2 + §7.4: only ALLCAPS_TOKEN values survive redactor; an unknown
    // token silently falls through as a no-op render, not a leak.
    out.publicExplanationTokens = raw.publicExplanationTokens
      .filter((token): token is string => typeof token === "string" && /^[A-Z][A-Z0-9_]+$/.test(token));
  }
  if (typeof raw.generatedAt === "string") out.generatedAt = raw.generatedAt;
  return out;
}

function formatPrice(amount: number | undefined, currency: string | undefined): string {
  if (typeof amount !== "number" || Number.isNaN(amount)) return "—";
  // Spec §4.2 / §7.3.2: price is always rendered with currency.
  // We avoid Intl.NumberFormat because the currency code is data-driven
  // and a runtime Intl failure would blank the line.
  return `${currency ?? "—"} ${amount.toFixed(2)}`;
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function isExpired(iso: string | undefined): boolean {
  if (!iso) return false;
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) && ts < Date.now();
}

const STATUS_BADGE: Record<ListedPlan["status"], string> = {
  DRAFT: "bg-[var(--w-fog)] text-[var(--w-ink)]",
  PROPOSED: "bg-[var(--w-highlight)] text-[var(--w-ink)]",
  ACTIVE: "bg-emerald-100 text-emerald-900",
  STALE: "bg-[var(--w-mist)] text-[var(--w-ink)]",
  SUPERSEDED: "bg-[var(--w-mist)] text-[var(--w-ink)]",
};