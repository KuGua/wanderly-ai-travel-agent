"use client";

import { useCallback, useState } from "react";

import {
  personalResearchActivitiesDraftSchema,
  type PersonalResearchActivitiesDraft,
  type PersonalResearchAnswersRequest,
} from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — activities input card (§3.5 stage 2).
 *
 * Owner-only typed draft editor for the `activities.search` capability.
 * Follows the `PlacesResearchInputCard` pattern: every field is a typed
 * slot the owner fills in, parsed by the shared Zod draft schema before
 * it is saved, so a malformed draft is refused here rather than at
 * confirm time.
 *
 * Privacy: no chat body, nationality, or document field ever enters the
 * draft. Results are owner-only and cannot seed Shared plan evidence.
 * Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface ActivitiesResearchInputCardProps {
  runId: string;
  schemaVersion: number;
  initialDraft?: PersonalResearchActivitiesDraft | null;
  onSaved?: (nextSchemaVersion: number, draft: PersonalResearchActivitiesDraft) => void;
  onConfirmReady?: (draft: PersonalResearchActivitiesDraft) => void;
  saveAnswers(runId: string, input: PersonalResearchAnswersRequest): Promise<void>;
}

const DEFAULT_DRAFT: PersonalResearchActivitiesDraft = {
  kind: "ACTIVITIES_SEARCH",
  destinationCode: "",
  startDate: "",
  endDate: "",
  category: null,
  limit: 20,
};

export function ActivitiesResearchInputCard(props: ActivitiesResearchInputCardProps) {
  const initial = props.initialDraft ?? DEFAULT_DRAFT;
  const [destinationCode, setDestinationCode] = useState(initial.destinationCode);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [category, setCategory] = useState(initial.category ?? "");
  const [limit, setLimit] = useState(initial.limit ?? 20);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildDraft = useCallback((): PersonalResearchActivitiesDraft => {
    return personalResearchActivitiesDraftSchema.parse({
      kind: "ACTIVITIES_SEARCH",
      destinationCode,
      startDate,
      endDate,
      // An empty box means "no category filter", not a category named "".
      category: category.trim() === "" ? null : category.trim(),
      limit,
    });
  }, [destinationCode, startDate, endDate, category, limit]);

  const onSave = useCallback(async () => {
    setError(null);
    let draft: PersonalResearchActivitiesDraft;
    try {
      draft = buildDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid activities draft");
      return;
    }
    setSubmitting(true);
    try {
      await props.saveAnswers(props.runId, { schemaVersion: 1 as const, draft });
      props.onSaved?.(props.schemaVersion + 1, draft);
      props.onConfirmReady?.(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save activities draft");
    } finally {
      setSubmitting(false);
    }
  }, [buildDraft, props]);

  return (
    <section
      data-testid="activities-research-input-card"
      data-capability="activities.search"
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: 12,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 16 }}>查询真实活动</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          将向 Viator 活动供应商发起查询，结果仅你可见且不入共享行程。
        </p>
      </header>

      <FieldRow>
        <TextInput label="目的地" value={destinationCode} onChange={setDestinationCode} placeholder="例如 Tokyo" />
        <TextInput label="类别（可留空）" value={category} onChange={setCategory} placeholder="例如 Museum" />
      </FieldRow>

      <FieldRow>
        <DateInput label="开始日期" value={startDate} onChange={setStartDate} />
        <DateInput label="结束日期" value={endDate} onChange={setEndDate} />
      </FieldRow>

      <NumberInput label="结果上限" min={1} max={50} value={limit} onChange={setLimit} />

      {error ? (
        <p data-testid="activities-research-input-error" role="alert" style={{ color: "var(--color-danger, #b91c1c)" }}>
          {error}
        </p>
      ) : null}

      <footer style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          data-testid="activities-research-input-submit"
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

function TextInput(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13 }}>{props.label}</span>
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
      />
    </label>
  );
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

function NumberInput(props: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13 }}>{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
      />
    </label>
  );
}
