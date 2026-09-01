"use client";

import { useCallback, useState } from "react";

import {
  personalResearchFlightDraftSchema,
  type PersonalResearchAnswersRequest,
  type PersonalResearchFlightDraft,
} from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — flight input card.
 *
 * Owner-only typed draft editor for `flight.search` capability. The card
 * surfaces the typed-input contract from the server's Zod discriminated
 * union and writes the validated envelope via
 * `PUT /agent-runs/:runId/personal-research/answers`. The "确认真实查询"
 * confirm modal lives in `ResearchConfirmationCard`; this card only emits
 * the draft and its submit hint.
 *
 * Privacy: no nationality, document, or chat-body field ever enters the
 * draft. The server-side Zod schema rejects any extra keys at parse time.
 *
 * Source: docs/draft-personal-research-implementation.md §3.3, §3.5.
 */

interface FlightResearchInputCardProps {
  runId: string;
  schemaVersion: number;
  initialDraft?: PersonalResearchFlightDraft | null;
  onSaved?: (nextSchemaVersion: number, draft: PersonalResearchFlightDraft) => void;
  onConfirmReady?: (draft: PersonalResearchFlightDraft) => void;
  saveAnswers(runId: string, input: PersonalResearchAnswersRequest): Promise<void>;
}

const CABIN_OPTIONS = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] as const;
type Cabin = (typeof CABIN_OPTIONS)[number];

export function FlightResearchInputCard(props: FlightResearchInputCardProps) {
  const initial = props.initialDraft;
  const [origin, setOrigin] = useState(initial?.originId ?? "");
  const [destination, setDestination] = useState(initial?.destinationId ?? "");
  const [departureDate, setDepartureDate] = useState(initial?.departureDate ?? "");
  const [returnDate, setReturnDate] = useState(initial?.returnDate ?? "");
  const [tripType, setTripType] = useState<"ONE_WAY" | "ROUND_TRIP">(initial?.tripType ?? "ROUND_TRIP");
  const [adults, setAdults] = useState(initial?.adults ?? 1);
  const [cabin, setCabin] = useState<Cabin>(initial?.cabin ?? "ECONOMY");
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildDraft = useCallback((): PersonalResearchFlightDraft => {
    return personalResearchFlightDraftSchema.parse({
      kind: "FLIGHT_SEARCH",
      originId: origin.toUpperCase(),
      destinationId: destination.toUpperCase(),
      tripType,
      departureDate,
      returnDate: tripType === "ONE_WAY" ? null : (returnDate || null),
      adults,
      cabin,
      currency: currency.toUpperCase(),
    });
  }, [origin, destination, tripType, departureDate, returnDate, adults, cabin, currency]);

  const onSave = useCallback(async () => {
    setError(null);
    let draft: PersonalResearchFlightDraft;
    try {
      draft = buildDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid flight draft");
      return;
    }
    setSubmitting(true);
    try {
      await props.saveAnswers(props.runId, { schemaVersion: 1 as const, draft });
      props.onSaved?.(props.schemaVersion + 1, draft);
      props.onConfirmReady?.(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save flight draft");
    } finally {
      setSubmitting(false);
    }
  }, [buildDraft, props]);

  return (
    <section
      data-testid="flight-research-input-card"
      data-capability="flight.search"
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: 12,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 16 }}>查询真实航班</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          将向已配置的航班供应商发起查询，结果仅你可见。行程未完成也可继续；建议先规划以获得更完整的方案。
        </p>
      </header>

      <FieldRow>
        <TextInput label="出发机场 (IATA)" value={origin} onChange={setOrigin} maxLength={3} placeholder="PEK" />
        <TextInput label="到达机场 (IATA)" value={destination} onChange={setDestination} maxLength={3} placeholder="NRT" />
      </FieldRow>

      <FieldRow>
        <DateInput label="出发日期" value={departureDate} onChange={setDepartureDate} required />
        {tripType === "ROUND_TRIP" ? (
          <DateInput label="返回日期" value={returnDate} onChange={setReturnDate} required />
        ) : (
          <div />
        )}
      </FieldRow>

      <FieldRow>
        <SelectField
          label="行程类型"
          value={tripType}
          onChange={(v) => setTripType(v as "ONE_WAY" | "ROUND_TRIP")}
          options={[
            { value: "ROUND_TRIP", label: "往返" },
            { value: "ONE_WAY", label: "单程" },
          ]}
        />
        <NumberInput label="成人数" min={1} max={9} value={adults} onChange={setAdults} />
      </FieldRow>

      <FieldRow>
        <SelectField
          label="舱位"
          value={cabin}
          onChange={(v) => setCabin(v as Cabin)}
          options={CABIN_OPTIONS.map((c) => ({ value: c, label: c }))}
        />
        <TextInput label="币种 (ISO)" value={currency} onChange={setCurrency} maxLength={3} placeholder="USD" />
      </FieldRow>

      {error ? (
        <p data-testid="flight-research-input-error" role="alert" style={{ color: "var(--color-danger, #b91c1c)" }}>
          {error}
        </p>
      ) : null}

      <footer style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          data-testid="flight-research-input-submit"
          type="button"
          disabled={submitting}
          onClick={onSave}
          style={{ padding: "8px 16px" }}
        >
          {submitting ? "保存中…" : "保存查询草稿"}
        </button>
      </footer>
    </section>
  );
}

function FieldRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>{children}</div>;
}

function TextInput(props: { label: string; value: string; onChange: (v: string) => void; maxLength?: number; placeholder?: string }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13 }}>{props.label}</span>
      <input
        type="text"
        value={props.value}
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
      />
    </label>
  );
}

function DateInput(props: { label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13 }}>{props.label}</span>
      <input
        type="date"
        value={props.value}
        required={props.required}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
      />
    </label>
  );
}

function NumberInput(props: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13 }}>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
      />
    </label>
  );
}

function SelectField<T extends string>(props: { label: string; value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; label: string }> }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13 }}>{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value as T)}
        style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
      >
        {props.options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}