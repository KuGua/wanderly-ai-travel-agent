import { useMemo, useRef, useState, type ReactNode } from "react";

import {
  type PersonalResearchMissingCode,
  type PersonalResearchReadiness,
  type ResearchCapability,
  MISSING_COPY,
  realProviderCapabilities,
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";

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
  // Quick orchestration — budget hint surfaces inline as a soft warning.
  // It is in-scope for rendering but does NOT count as a blocker for the
  // confirm-enable check (categorized as `warning`, not `blocker`, on the
  // server).
  "BUDGET_HINT_MISSING",
];

export function ResearchSetupCard({
  tripId,
  runId,
  readiness,
  blockers,
  warnings,
  intent,
  setupSession,
  onDismiss,
}: {
  tripId: string;
  runId: string;
  readiness: PersonalResearchReadiness;
  /** Hard gaps — research cannot start until these are resolved. */
  blockers: PersonalResearchMissingCode[];
  /** Soft advisories — research can start, but quality may degrade. */
  warnings: PersonalResearchMissingCode[];
  intent: { kind: "RESEARCH_ONLY" | "PROPOSE_PLAN"; requestedCapabilities: string[] };
  setupSession?: ResearchSetupSessionResponse | null;
  onDismiss: () => void;
}): ReactNode {
  if (!setupSession || !isInScope(blockers)) {
    return <ReadOnlySetupCard
      readiness={readiness}
      blockers={blockers}
      warnings={warnings}
      intent={intent}
      onDismiss={onDismiss}
    />;
  }
  return <ConversationalSetupCard
    tripId={tripId}
    runId={runId}
    session={setupSession}
    blockers={blockers}
    warnings={warnings}
    intent={intent}
    onDismiss={onDismiss}
  />;
}

function isInScope(blockers: PersonalResearchMissingCode[]): boolean {
  if (blockers.length === 0) return false;
  return blockers.every((code) => IN_SCOPE_MISSING.includes(code));
}
// ─── Read-only fallback (unchanged behavior) ──────────────────────────────

function ReadOnlySetupCard({
  readiness,
  blockers,
  warnings,
  intent,
  onDismiss,
}: {
  readiness: PersonalResearchReadiness;
  blockers: PersonalResearchMissingCode[];
  warnings: PersonalResearchMissingCode[];
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
      {blockers.length > 0 ? (
        <ul className="mb-3 space-y-2" data-testid="setup-card-blockers">
          {blockers.map((code) => {
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
      ) : null}
      {warnings.length > 0 ? (
        <div className="mb-3 rounded-md border border-border bg-muted/40 p-2" data-testid="setup-card-warnings">
          <p className="mb-1 text-xs font-medium text-muted-foreground">提示（可继续）：</p>
          <ul className="list-disc pl-4 text-xs text-muted-foreground">
            {warnings.map((code) => {
              const copy = MISSING_COPY[code];
              return (
                <li key={code}>
                  <span>{copy.title}</span>
                  <span className="ml-1 text-muted-foreground/80">— {copy.detail}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
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
  blockers,
  warnings,
  intent,
  onDismiss,
}: {
  tripId: string;
  runId: string;
  session: ResearchSetupSessionResponse;
  blockers: PersonalResearchMissingCode[];
  warnings: PersonalResearchMissingCode[];
  intent: { kind: "RESEARCH_ONLY" | "PROPOSE_PLAN"; requestedCapabilities: string[] };
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
  // Quick orchestration — soft budget hint. Always optional; absence does
  // not block confirm. Surfaced inline so the owner can declare an amount
  // if they care to bias provider pricing ranges.
  const [budgetAmount, setBudgetAmount] = useState<string>(
    session.budgetHint ? String(session.budgetHint.amount) : "",
  );
  const [budgetCurrency, setBudgetCurrency] = useState<string>(
    session.budgetHint?.currency ?? "USD",
  );
  const [budgetCadence, setBudgetCadence] = useState<"TOTAL" | "PER_NIGHT" | "PER_PERSON">(
    session.budgetHint?.cadence ?? "TOTAL",
  );
  const confirmRequestId = useRef<string | null>(null);
  const submissionInFlight = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<Error | null>(null);

  // Real-provider acknowledgement gate (Phase 2). When the requested
  // capabilities hit any paid/limited provider (flight / hotel / etc.),
  // the confirm path opens a `ConfirmDialog` first.
  const realProviders = realProviderCapabilities(
    intent.requestedCapabilities as ResearchCapability[],
  );
  const needsRealProviderAck = realProviders.length > 0;
  const realProviderKey = needsRealProviderAck
    ? `research.realProviderAcked.${[...realProviders].sort().join("|")}`
    : "";
  const [realProviderModalOpen, setRealProviderModalOpen] = useState(false);

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

  const budgetValid = useMemo(() => {
    // Empty budget = "no hint" → always valid (warning, not blocker).
    if (budgetAmount === "") return true;
    const parsed = Number(budgetAmount);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return false;
    if (parsed <= 0 || parsed > 1_000_000) return false;
    return /^[A-Z]{3}$/.test(budgetCurrency);
  }, [budgetAmount, budgetCurrency]);

  // Only the in-scope *blocker* codes drive the confirm enable check.
  // Soft warnings (including `BUDGET_HINT_MISSING`) never block — the
  // owner can proceed past them via the real-provider acknowledgement
  // dialog. BUDGET is excluded from the blocker gate even though it's
  // listed in `IN_SCOPE_MISSING` for rendering.
  const blockerCodes = blockers.filter(
    (code) => IN_SCOPE_MISSING.includes(code) && code !== "BUDGET_HINT_MISSING",
  );
  const hasBlockers = blockerCodes.length > 0;
  const confirmEnabled = !hasBlockers && blockerCodes.every((code) => {
    if (code === "DATES_MISSING") return datesValid;
    if (code === "STAY_PREFERENCES_MISSING") return stayValid;
    return false;
  });

  function isRealProviderAcked(): boolean {
    if (!needsRealProviderAck) return true;
    try {
      return sessionStorage.getItem(realProviderKey) === "1";
    } catch {
      return false;
    }
  }

  function markRealProviderAcked(): void {
    if (!needsRealProviderAck) return;
    try {
      sessionStorage.setItem(realProviderKey, "1");
    } catch {
      /* sessionStorage unavailable — fall through and re-prompt next time. */
    }
  }

  const submitAnswer = async (expectedVersion: number, patch: ResearchSetupAnswer) => {
    const result = await saveAnswer.mutateAsync({ expectedVersion, patch });
    return result.session;
  };

  async function persistRequiredAnswers(currentSession: ResearchSetupSessionResponse): Promise<ResearchSetupSessionResponse> {
    let next = currentSession;
    if (blockerCodes.includes("DATES_MISSING") && datesValid) {
      next = await submitAnswer(next.version, {
        field: "travelDates",
        value: { start: checkIn, end: checkOut },
      });
    }
    if (blockerCodes.includes("STAY_PREFERENCES_MISSING") && stayValid) {
      next = await submitAnswer(next.version, {
        field: "stayPreferences",
        value: {
          roomCount,
          adultsPerRoom: ensureAdultsLength(roomCount, adultsPerRoom),
          currency,
        },
      });
    }
    // Quick orchestration — budget hint. Only submit when the user has
    // actually typed an amount; empty input is "no hint" (the existing
    // behavior). Validation is mirrored from the server Zod schema.
    if (budgetAmount !== "" && budgetValid) {
      next = await submitAnswer(next.version, {
        field: "budget",
        value: {
          amount: Number(budgetAmount),
          currency: budgetCurrency,
          cadence: budgetCadence,
        },
      });
    }
    return next;
  }

  async function fireConfirm(): Promise<void> {
    const requestId = confirmRequestId.current ?? crypto.randomUUID();
    confirmRequestId.current = requestId;
    recordUiDiagnostic("setup.confirm", {
      capabilities: intent.requestedCapabilities,
    });
    await confirm.mutateAsync({ requestId });
  }

  const onConfirm = async () => {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    setIsSubmitting(true);
    setSubmissionError(null);
    try {
      await persistRequiredAnswers(session);
      if (needsRealProviderAck && !isRealProviderAcked()) {
        setRealProviderModalOpen(true);
        return;
      }
      await fireConfirm();
    } catch (error) {
      setSubmissionError(error instanceof Error ? error : new Error("提交失败，请重试"));
    } finally {
      submissionInFlight.current = false;
      setIsSubmitting(false);
    }
  };

  async function handleModalConfirm(): Promise<void> {
    markRealProviderAcked();
    setRealProviderModalOpen(false);
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    setIsSubmitting(true);
    setSubmissionError(null);
    try {
      await fireConfirm();
    } catch (error) {
      setSubmissionError(error instanceof Error ? error : new Error("提交失败，请重试"));
    } finally {
      submissionInFlight.current = false;
      setIsSubmitting(false);
    }
  }

  function handleModalCancel(): void {
    recordUiDiagnostic("research.real_provider_declined", {
      capabilities: realProviders,
    });
    setRealProviderModalOpen(false);
  }

  return (
    <div
      data-testid="research-hotel-setup-card"
      data-readiness="NEEDS_SETUP"
      className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="mb-2 font-medium">补全资料后即可开始研究</p>
      <ul className="mb-3 space-y-2">
        {blockerCodes.includes("DATES_MISSING") && (
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
        {blockerCodes.includes("STAY_PREFERENCES_MISSING") && (
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
        {/* Quick orchestration — soft budget hint. Always optional; surface
            in the warnings list when missing or as a small read-only summary
            when already declared. Does NOT block the confirm button. */}
        {(blockers.includes("BUDGET_HINT_MISSING") || warnings.includes("BUDGET_HINT_MISSING")) && (
          <li
            className="rounded-md border border-sky-200 bg-white p-2"
            data-testid="setup-budget-hint"
          >
            <p className="text-xs font-medium text-sky-900">
              {MISSING_COPY.BUDGET_HINT_MISSING?.title ?? "本次预算（可选）"}
            </p>
            <p className="mt-0.5 text-[11px] text-sky-700">
              {MISSING_COPY.BUDGET_HINT_MISSING?.detail ?? "预算仅用于偏向供应商价格区间，非强制。"}
            </p>
            <div className="mt-1 grid grid-cols-3 gap-2">
              <label className="grid gap-1 text-[11px]">
                金额
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={1_000_000}
                  value={budgetAmount}
                  onChange={(event) => setBudgetAmount(event.target.value)}
                  placeholder="可留空"
                  className="min-h-9 border bg-background px-2 text-xs"
                  data-testid="setup-budget-amount"
                />
              </label>
              <label className="grid gap-1 text-[11px]">
                币种
                <input
                  type="text"
                  value={budgetCurrency}
                  onChange={(event) => setBudgetCurrency(event.target.value.toUpperCase())}
                  className="min-h-9 border bg-background px-2 text-xs uppercase"
                  maxLength={3}
                  data-testid="setup-budget-currency"
                />
              </label>
              <label className="grid gap-1 text-[11px]">
                范围
                <select
                  value={budgetCadence}
                  onChange={(event) => setBudgetCadence(event.target.value as typeof budgetCadence)}
                  className="min-h-9 border bg-background px-2 text-xs"
                  data-testid="setup-budget-cadence"
                >
                  <option value="TOTAL">总计</option>
                  <option value="PER_NIGHT">每晚</option>
                  <option value="PER_PERSON">人均</option>
                </select>
              </label>
            </div>
            {!budgetValid && (
              <p className="mt-1 text-[11px] text-rose-600">
                金额需为 1 到 1,000,000 的整数；币种需为 3 个大写字母。
              </p>
            )}
          </li>
        )}
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            void onConfirm();
          }}
          disabled={!confirmEnabled || isSubmitting || cancel.isPending}
          className="min-h-11 rounded-full bg-amber-600 px-3 text-xs font-bold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30"
          data-testid="setup-confirm"
        >
          {isSubmitting ? "提交中…" : "确认并搜索"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (cancel.isPending || isSubmitting) return;
            cancel.mutate();
            onDismiss();
          }}
          disabled={cancel.isPending || isSubmitting}
          className="min-h-11 rounded-full border border-amber-300 px-3 text-xs font-bold text-amber-900 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/30"
          data-testid="setup-cancel"
        >
          关闭
        </button>
      </div>
      {saveAnswer.isError && !submissionError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          保存失败：{(saveAnswer.error as Error).message}
        </p>
      )}
      {confirm.isError && !submissionError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          提交失败：{(confirm.error as Error).message}
        </p>
      )}
      {submissionError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          提交失败：{submissionError.message}
        </p>
      )}
      {cancel.isError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          取消失败：{(cancel.error as Error).message}
        </p>
      )}
      <ConfirmDialog
        open={realProviderModalOpen}
        title="本次研究将调用真实供应商"
        body={`你请求的研究会向 ${realProviders.join("、")} 发送实时查询，可能产生费用或占用配额。结果与最终行程可能不完全匹配。`}
        acknowledgeLabel="我已知晓，仍要继续"
        confirmLabel="继续运行"
        cancelLabel="取消"
        capabilities={realProviders as ResearchCapability[]}
        diagnosticTag="research.real_provider_acknowledged"
        onConfirm={() => { void handleModalConfirm(); }}
        onCancel={handleModalCancel}
      />
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
