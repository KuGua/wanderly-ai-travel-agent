"use client";

import { useCallback, useState } from "react";

import {
  personalResearchPlacesDraftSchema,
  type PersonalResearchAnswersRequest,
  type PersonalResearchPlacesDraft,
} from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — places input card (§3.5 stage 3).
 *
 * Owner-only typed draft editor for `places.search` capability. Mirrors the
 * `FlightResearchInputCard` pattern but for point-of-interest queries.
 * Personal places results are STRICTLY owner-advisory — the executor
 * never writes to `trip_places`. The owner manually adopts suggestions via
 * the Shared `/trips/:tripId/route-endpoints` adopt endpoint.
 *
 * Privacy: no nationality, document, or chat-body field ever enters the
 * draft. Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface PlacesResearchInputCardProps {
  runId: string;
  schemaVersion: number;
  initialDraft?: PersonalResearchPlacesDraft | null;
  onSaved?: (nextSchemaVersion: number, draft: PersonalResearchPlacesDraft) => void;
  onConfirmReady?: (draft: PersonalResearchPlacesDraft) => void;
  saveAnswers(runId: string, input: PersonalResearchAnswersRequest): Promise<void>;
}

const CATEGORIES = [
  { value: null, label: "全部" },
  { value: "ATTRACTION", label: "景点" },
  { value: "HOTEL", label: "酒店" },
  { value: "RESTAURANT", label: "餐厅" },
  { value: "TRANSPORT_HUB", label: "交通枢纽" },
  { value: "OTHER", label: "其他" },
] as const;

const DEFAULT_DRAFT: PersonalResearchPlacesDraft = {
  kind: "PLACES_SEARCH",
  latitude: 35.68,
  longitude: 139.69,
  radiusMeters: 1500,
  category: "ATTRACTION",
  limit: 20,
};

export function PlacesResearchInputCard(props: PlacesResearchInputCardProps) {
  const initial = props.initialDraft ?? DEFAULT_DRAFT;
  const [latitude, setLatitude] = useState(initial.latitude);
  const [longitude, setLongitude] = useState(initial.longitude);
  const [radius, setRadius] = useState(initial.radiusMeters);
  const [category, setCategory] = useState(initial.category);
  const [limit, setLimit] = useState(initial.limit ?? 20);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildDraft = useCallback((): PersonalResearchPlacesDraft => {
    return personalResearchPlacesDraftSchema.parse({
      kind: "PLACES_SEARCH",
      latitude,
      longitude,
      radiusMeters: radius,
      category,
      limit,
    });
  }, [latitude, longitude, radius, category, limit]);

  const onSave = useCallback(async () => {
    setError(null);
    let draft: PersonalResearchPlacesDraft;
    try {
      draft = buildDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid places draft");
      return;
    }
    setSubmitting(true);
    try {
      await props.saveAnswers(props.runId, { schemaVersion: 1 as const, draft });
      props.onSaved?.(props.schemaVersion + 1, draft);
      props.onConfirmReady?.(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save places draft");
    } finally {
      setSubmitting(false);
    }
  }, [buildDraft, props]);

  return (
    <section
      data-testid="places-research-input-card"
      data-capability="places.search"
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: 12,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 16 }}>查询真实地点</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          将向 ORS 地点供应商发起查询，结果仅你可见且不入共享行程。建议先规划后再采纳到 Trip Places。
        </p>
      </header>

      <FieldRow>
        <NumberInput label="纬度" value={latitude} onChange={setLatitude} step={0.0001} />
        <NumberInput label="经度" value={longitude} onChange={setLongitude} step={0.0001} />
      </FieldRow>

      <FieldRow>
        <NumberInput label="搜索半径 (米)" min={100} max={50_000} value={radius} onChange={(v) => setRadius(v)} />
        <NumberInput label="结果上限" min={1} max={50} value={limit} onChange={(v) => setLimit(v)} />
      </FieldRow>

      <SelectField
        label="类别"
        value={category ?? ""}
        onChange={(v) => setCategory((v === "" ? null : v) as PersonalResearchPlacesDraft["category"])}
        options={CATEGORIES.map((c) => ({ value: c.value ?? "", label: c.label }))}
      />

      {error ? (
        <p data-testid="places-research-input-error" role="alert" style={{ color: "var(--color-danger, #b91c1c)" }}>
          {error}
        </p>
      ) : null}

      <footer style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          data-testid="places-research-input-submit"
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