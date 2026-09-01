"use client";

import { useCallback, useState } from "react";

import {
  personalResearchHotelDraftSchema,
  type PersonalResearchAnswersRequest,
  type PersonalResearchHotelDraft,
} from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — hotel input card ( §3.5 stage2).
 *
 * Owner-only typed draft editor for `hotel.search` capability. Mirrors the
 * `FlightResearchInputCard` pattern but for hotel inputs. The "确认真实查询"
 * confirm modal lives in `ResearchConfirmationCard` and is wired by the chat
 * surface; this card only emits the validated envelope via
 * `PUT /agent-runs/:runId/personal-research/answers`.
 *
 * Privacy: no nationality, document, or chat-body field ever enters the
 * draft. The server-side Zod schema rejects any extra keys at parse time.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface HotelResearchInputCardProps {
  runId: string;
  schemaVersion: number;
  initialDraft?: PersonalResearchHotelDraft | null;
  onSaved?: (nextSchemaVersion: number, draft: PersonalResearchHotelDraft) => void;
  onConfirmReady?: (draft: PersonalResearchHotelDraft) => void;
  saveAnswers(runId: string, input: PersonalResearchAnswersRequest): Promise<void>;
}

const DEFAULT_HOTEL_DRAFT: PersonalResearchHotelDraft = {
  kind: "HOTEL_SEARCH",
  cityCode: "TYO",
  checkIn: "",
  checkOut: "",
  occupancy: { adults: 2, rooms: 1 },
  currency: "USD",
};

export function HotelResearchInputCard(props: HotelResearchInputCardProps) {
  const initial = props.initialDraft ?? DEFAULT_HOTEL_DRAFT;
  const [cityCode, setCityCode] = useState(initial.cityCode);
  const [checkIn, setCheckIn] = useState(initial.checkIn);
  const [checkOut, setCheckOut] = useState(initial.checkOut);
  const [adults, setAdults] = useState(initial.occupancy.adults);
  const [rooms, setRooms] = useState(initial.occupancy.rooms);
  const [currency, setCurrency] = useState(initial.currency);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildDraft = useCallback((): PersonalResearchHotelDraft => {
    return personalResearchHotelDraftSchema.parse({
      kind: "HOTEL_SEARCH",
      cityCode: cityCode.toUpperCase(),
      checkIn,
      checkOut,
      occupancy: { adults, rooms },
      currency: currency.toUpperCase(),
    });
  }, [cityCode, checkIn, checkOut, adults, rooms, currency]);

  const onSave = useCallback(async () => {
    setError(null);
    let draft: PersonalResearchHotelDraft;
    try {
      draft = buildDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid hotel draft");
      return;
    }
    setSubmitting(true);
    try {
      await props.saveAnswers(props.runId, { schemaVersion: 1 as const, draft });
      props.onSaved?.(props.schemaVersion + 1, draft);
      props.onConfirmReady?.(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save hotel draft");
    } finally {
      setSubmitting(false);
    }
  }, [buildDraft, props]);

  return (
    <section
      data-testid="hotel-research-input-card"
      data-capability="hotel.search"
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: 12,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 16 }}>查询真实酒店</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          将向向所配置的酒店供应商发起查询，结果仅你可见。行程未完成也可继续；建议先规划以获得更完整的方案。
        </p>
      </header>

      <FieldRow>
        <TextInput label="城市代码 (IATA)" value={cityCode} onChange={setCityCode} maxLength={3} placeholder="TYO" />
        <TextInput label="币种 (ISO)" value={currency} onChange={setCurrency} maxLength={3} placeholder="USD" />
      </FieldRow>

      <FieldRow>
        <DateInput label="入住日期" value={checkIn} onChange={setCheckIn} required />
        <DateInput label="退房日期" value={checkOut} onChange={setCheckOut} required />
      </FieldRow>

      <FieldRow>
        <NumberInput label="成人数" min={1} max={8} value={adults} onChange={setAdults} />
        <NumberInput label="房间数" min={1} max={8} value={rooms} onChange={setRooms} />
      </FieldRow>

      {error ? (
        <p data-testid="hotel-research-input-error" role="alert" style={{ color: "var(--color-danger, #b91c1c)" }}>
          {error}
        </p>
      ) : null}

      <footer style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          data-testid="hotel-research-input-submit"
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