import { useMemo, useRef, useState, type ReactNode } from "react";

import {
  type PersonalResearchMissingCode,
  type PersonalResearchReadiness,
  MISSING_COPY,
  renderReadinessHeadline,
} from "@/lib/trips/personal-research-readiness-copy";
import {
  type ResearchSetupAnswer,
  type ResearchSetupSessionResponse,
} from "@/lib/api/contracts";
import {
  useSaveResearchSetupAnswer,
  useCancelResearchSetup,
  useConfirmResearchSetup,
} from "@/lib/query/hooks";

/**
 * Personal Research Setup — conversational completion card (Phase §9).
 *
 * Two-tier rendering:
 *   1. When a `setupSession` is attached (server-projected by
 *      `toRunResponse`), render the editable inline form via
 *      `ConversationalSetupCard` so the owner can fill dates / stay
 *      prefs / flight prefs in chat context. Submit calls
 *      `POST /confirm-and-search`, which atomically writes trip-level
 *      fields, persists preference slots, cascades stale plans, and
 *      accepts the RESEARCH task.
 *   2. When no `setupSession` is attached (missing codes outside this
 *      card's scope, e.g. HOTEL_PROVIDER_NOT_APPROVED), render the
 *      existing read-only fallback with `MISSING_COPY` hints.
 *
 * SPEC invariant: this card never echoes the original chat question,
 * place names, or provider raw data. Every label is the bounded
 * `MISSING_COPY` table or a client-controlled slot value.
 */
const IN_SCOPE_MISSING: ReadonlyArray<PersonalResearchMissingCode> = [
  "DATES_MISSING",
  "STAY_PREFERENCES_MISSING",
];

export function ResearchSetupCard({
  tripId,
  runId,
  readiness,
  missing,
  intent,
  setupSession,
  onDismiss,
}: {
  tripId: string;
  runId: string;
  readiness: PersonalResearchReadiness;
  missing: PersonalResearchMissingCode[];
  intent: { kind: "RESEARCH_ONLY" | "PROPOSE_PLAN"; requestedCapabilities: string[] };
  setupSession?: ResearchSetupSessionResponse | null;
  onDismiss: () => void;
}): ReactNode {
  if (!setupSession || !isInScope(missing)) {
    return <ReadOnlySetupCard readiness={readiness} missing={missing} intent={intent} onDismiss={onDismiss} />;
  }
  return <ConversationalSetupCard
    tripId={tripId}
    runId={runId}
    session={setupSession}
    missing={missing}
    onDismiss={onDismiss}
  />;
}

function isInScope(missing: PersonalResearchMissingCode[]): boolean {
  if (missing.length === 0) return false;
  return missing.every((code) => IN_SCOPE_MISSING.includes(code));
}
// ─── Read-only fallback (unchanged behavior) ──────────────────────────────

function ReadOnlySetupCard({
  readiness,
  missing,
  intent,
  onDismiss,
}: {
  readiness: PersonalResearchReadiness;
  missing: PersonalResearchMissingCode[];
  intent: { kind: "RESEARCH_ONLY" | "PROPOSE_PLAN"; requestedCapabilities: string[] };
  onDismiss: () => void;
}): ReactNode {
  const headline = renderReadinessHeadline(readiness);
  return (
    <div
      data-testid="research-setup-card"
      data-readiness={readiness}
      className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="mb-2 font-medium">{headline.headline}</p>
      <p className="mb-2 text-xs">{headline.body}</p>
      <p className="mb-2 text-xs text-muted-foreground">
        模式：{intent.kind === "PROPOSE_PLAN" ? "研究 + 自动生成方案" : "仅研究"}
      </p>
      <ul className="mb-3 space-y-2">
        {missing.map((code) => {
          const copy = MISSING_COPY[code];
          return (
            <li key={code} className="rounded-md border border-amber-200 bg-white p-2">
              <p className="text-xs font-medium">{copy.title}</p>
              <p className="text-xs text-muted-foreground">{copy.detail}</p>
              <p className="mt-1 text-xs italic text-muted-foreground">{copy.ctaHint}</p>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-11 rounded-full border border-amber-300 px-3 text-xs font-bold text-amber-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

// ─── Conversational completion card ────────────────────────────────────────

function ConversationalSetupCard({
  tripId,
  runId,
  session,
  missing,
  onDismiss,
}: {
  tripId: string;
  runId: string;
  session: ResearchSetupSessionResponse;
  missing: PersonalResearchMissingCode[];
  onDismiss: () => void;
}): ReactNode {
  const saveAnswer = useSaveResearchSetupAnswer(runId);
  const cancel = useCancelResearchSetup(runId);
  const confirm = useConfirmResearchSetup(runId, tripId);

  // Local editable state mirrors server-side slots. Server-side Zod is
  // the source of truth; client-side superRefine mirrors the schema for
  // instant validation feedback.
  const [checkIn, setCheckIn] = useState<string>(
    session.travelDateStart ?? "",
  );
  const [checkOut, setCheckOut] = useState<string>(
    session.travelDateEnd ?? "",
  );
  const [roomCount, setRoomCount] = useState<number>(
    session.stayPreferences?.roomCount ?? 1,
  );
  const [adultsPerRoom, setAdultsPerRoom] = useState<number[]>(
    session.stayPreferences?.adultsPerRoom ?? [1],
  );
  const [currency, setCurrency] = useState<string>(
    session.stayPreferences?.currency ?? "USD",
  );
  const confirmRequestId = useRef<string | null>(null);

  const datesValid = useMemo(() => {
    if (!checkIn || !checkOut) return false;
    return checkOut > checkIn;
  }, [checkIn, checkOut]);

  const stayValid = useMemo(() => {
    if (roomCount < 1 || roomCount > 8) return false;
    if (adultsPerRoom.length !== roomCount) return false;
    if (adultsPerRoom.some((a) => a < 1 || a > 8)) return false;
    return /^[A-Z]{3}$/.test(currency);
  }, [roomCount, adultsPerRoom, currency]);

  // Only the in-scope missing codes drive the confirm enable check.
  const requiredCodes = missing.filter((code) => IN_SCOPE_MISSING.includes(code));
  const confirmEnabled = requiredCodes.every((code) => {
    if (code === "DATES_MISSING") return datesValid;
    if (code === "STAY_PREFERENCES_MISSING") return stayValid;
    return false;
  });

  const submitAnswer = async (expectedVersion: number, patch: ResearchSetupAnswer) => {
    const result = await saveAnswer.mutateAsync({ expectedVersion, patch });
    return result.session;
  };

  const onConfirm = async () => {
    let currentSession = session;
    // Persist any field that's still missing in the session.
    if (requiredCodes.includes("DATES_MISSING") && datesValid) {
      currentSession = await submitAnswer(currentSession.version, {
        field: "travelDates",
        value: { start: checkIn, end: checkOut },
      });
    }
    if (requiredCodes.includes("STAY_PREFERENCES_MISSING") && stayValid) {
      currentSession = await submitAnswer(currentSession.version, {
        field: "stayPreferences",
        value: {
          roomCount,
          adultsPerRoom: ensureAdultsLength(roomCount, adultsPerRoom),
          currency,
        },
      });
    }
    // Generate an idempotent requestId so retries hit the same RESEARCH task.
    const requestId = confirmRequestId.current ?? crypto.randomUUID();
    confirmRequestId.current = requestId;
    await confirm.mutateAsync({ requestId });
  };

  return (
    <div
      data-testid="research-hotel-setup-card"
      data-readiness="NEEDS_SETUP"
      className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="mb-2 font-medium">补全资料后即可开始研究</p>
      <ul className="mb-3 space-y-2">
        {requiredCodes.includes("DATES_MISSING") && (
          <li className="rounded-md border border-amber-200 bg-white p-2">
            <p className="text-xs font-medium">{MISSING_COPY.DATES_MISSING.title}</p>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-[11px]">
                入住
                <input
                  type="date"
                  value={checkIn}
                  min={todayIso()}
                  onChange={(event) => setCheckIn(event.target.value)}
                  className="min-h-9 border bg-background px-2 text-xs"
                  data-testid="setup-check-in"
                />
              </label>
              <label className="grid gap-1 text-[11px]">
                离店
                <input
                  type="date"
                  value={checkOut}
                  min={checkIn || todayIso()}
                  onChange={(event) => setCheckOut(event.target.value)}
                  className="min-h-9 border bg-background px-2 text-xs"
                  data-testid="setup-check-out"
                />
              </label>
            </div>
          </li>
        )}
        {requiredCodes.includes("STAY_PREFERENCES_MISSING") && (
          <li className="rounded-md border border-amber-200 bg-white p-2">
            <p className="text-xs font-medium">{MISSING_COPY.STAY_PREFERENCES_MISSING.title}</p>
            <div className="mt-1 grid grid-cols-3 gap-2">
              <label className="grid gap-1 text-[11px]">
                房间数
                <select
                  value={roomCount}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setRoomCount(next);
                    setAdultsPerRoom((current) => ensureAdultsLength(next, current));
                  }}
                  className="min-h-9 border bg-background px-2 text-xs"
                  data-testid="setup-room-count"
                >
                  {Array.from({ length: 8 }).map((_, i) => (
                    <option key={i + 1} value={i + 1}>{i + 1}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-[11px]">
                每间成人
                <select
                  value={adultsPerRoom[0] ?? 1}
                  onChange={(event) => {
                    const adults = Number(event.target.value);
                    setAdultsPerRoom(Array.from({ length: roomCount }, () => adults));
                  }}
                  className="min-h-9 border bg-background px-2 text-xs"
                  data-testid="setup-adults"
                >
                  {Array.from({ length: 8 }).map((_, i) => (
                    <option key={i + 1} value={i + 1}>{i + 1}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-[11px]">
                币种
                <input
                  type="text"
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                  className="min-h-9 border bg-background px-2 text-xs uppercase"
                  maxLength={3}
                  data-testid="setup-currency"
                />
              </label>
            </div>
          </li>
        )}
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            if (confirm.isPending) return;
            void onConfirm();
          }}
          disabled={!confirmEnabled || confirm.isPending || saveAnswer.isPending}
          className="min-h-11 rounded-full bg-amber-600 px-3 text-xs font-bold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30"
          data-testid="setup-confirm"
        >
          {confirm.isPending ? "提交中…" : "确认并搜索"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (cancel.isPending) return;
            cancel.mutate();
            onDismiss();
          }}
          disabled={cancel.isPending}
          className="min-h-11 rounded-full border border-amber-300 px-3 text-xs font-bold text-amber-900 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30"
          data-testid="setup-cancel"
        >
          关闭
        </button>
      </div>
      {saveAnswer.isError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          保存失败：{(saveAnswer.error as Error).message}
        </p>
      )}
      {confirm.isError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          提交失败：{(confirm.error as Error).message}
        </p>
      )}
      {cancel.isError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          取消失败：{(cancel.error as Error).message}
        </p>
      )}
    </div>
  );
}

function ensureAdultsLength(roomCount: number, current: number[]): number[] {
  if (current.length === roomCount) return current;
  if (current.length > roomCount) return current.slice(0, roomCount);
  const fill = current[current.length - 1] ?? 1;
  return [...current, ...Array.from({ length: roomCount - current.length }, () => fill)];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
