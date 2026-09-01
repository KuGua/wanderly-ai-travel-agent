"use client";

import { useCallback, useState } from "react";

import {
  personalResearchAccommodationDraftSchema,
  type PersonalResearchAccommodationDraft,
  type PersonalResearchAnswersRequest,
} from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — accommodation discovery input card (§3.5 stage 2).
 *
 * Owner-only typed draft editor for `accommodation.discovery`. Discovery
 * answers "what kind of places to stay are around here", not "what does a
 * room cost" — that is `hotel.search`. The draft is therefore a point plus
 * a radius plus a stay window, with no rate or board fields.
 *
 * Privacy: no nationality, document, or chat-body field ever enters the
 * draft. Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface AccommodationResearchInputCardProps {
  runId: string;
  schemaVersion: number;
  initialDraft?: PersonalResearchAccommodationDraft | null;
  onSaved?: (nextSchemaVersion: number, draft: PersonalResearchAccommodationDraft) => void;
  onConfirmReady?: (draft: PersonalResearchAccommodationDraft) => void;
  saveAnswers(runId: string, input: PersonalResearchAnswersRequest): Promise<void>;
}

const DEFAULT_DRAFT: PersonalResearchAccommodationDraft = {
  kind: "ACCOMMODATION_DISCOVERY",
  latitude: 35.68,
  longitude: 139.69,
  radiusMeters: 2000,
  checkIn: "",
  checkOut: "",
  occupancy: { adults: 2, rooms: 1 },
};

export function AccommodationResearchInputCard(props: AccommodationResearchInputCardProps) {
  const initial = props.initialDraft ?? DEFAULT_DRAFT;
  const [latitude, setLatitude] = useState(initial.latitude);
  const [longitude, setLongitude] = useState(initial.longitude);
  const [radius, setRadius] = useState(initial.radiusMeters);
  const [checkIn, setCheckIn] = useState(initial.checkIn);
  const [checkOut, setCheckOut] = useState(initial.checkOut);
  const [adults, setAdults] = useState(initial.occupancy.adults);
  const [rooms, setRooms] = useState(initial.occupancy.rooms);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildDraft = useCallback((): PersonalResearchAccommodationDraft => {
    return personalResearchAccommodationDraftSchema.parse({
      kind: "ACCOMMODATION_DISCOVERY",
      latitude,
      longitude,
      radiusMeters: radius,
      checkIn,
      checkOut,
      occupancy: { adults, rooms },
    });
  }, [latitude, longitude, radius, checkIn, checkOut, adults, rooms]);

  const onSave = useCallback(async () => {
    setError(null);
    let draft: PersonalResearchAccommodationDraft;
    try {
      draft = buildDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid accommodation draft");
      return;
    }
    setSubmitting(true);
    try {
      await props.saveAnswers(props.runId, { schemaVersion: 1 as const, draft });
      props.onSaved?.(props.schemaVersion + 1, draft);
      props.onConfirmReady?.(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save accommodation draft");
    } finally {
      setSubmitting(false);
    }
  }, [buildDraft, props]);

  return (
    <section
      data-testid="accommodation-research-input-card"
      data-capability="accommodation.discovery"
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: 12,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 16 }}>查询周边住宿</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          将向 OpenTripMap 发起查询，看这一带有哪些住宿。这里不含报价 —— 价格请用酒店查询。结果仅你可见且不入共享行程。
        </p>
      </header>

      <FieldRow>
        <NumberInput label="纬度" value={latitude} onChange={setLatitude} step={0.0001} />
        <NumberInput label="经度" value={longitude} onChange={setLongitude} step={0.0001} />
      </FieldRow>

      <NumberInput label="搜索半径 (米)" min={100} max={50_000} value={radius} onChange={setRadius} />

      <FieldRow>
        <DateInput label="入住" value={checkIn} onChange={setCheckIn} />
        <DateInput label="退房" value={checkOut} onChange={setCheckOut} />
      </FieldRow>

      <FieldRow>
        <NumberInput label="成人" min={1} max={8} value={adults} onChange={setAdults} />
        <NumberInput label="房间数" min={1} max={8} value={rooms} onChange={setRooms} />
      </FieldRow>

      {error ? (
        <p data-testid="accommodation-research-input-error" role="alert" style={{ color: "var(--color-danger, #b91c1c)" }}>
          {error}
        </p>
      ) : null}

      <footer style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          data-testid="accommodation-research-input-submit"
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

function DateInput(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13 }}>{props.label}</span>
      <input
        type="date"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
      />
    </label>
  );
}

function NumberInput(props: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13 }}>{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
      />
    </label>
  );
}
