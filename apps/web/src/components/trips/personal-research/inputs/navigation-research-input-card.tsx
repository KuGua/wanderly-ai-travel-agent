"use client";

import { useCallback, useState } from "react";

import {
  personalResearchNavigationRouteDraftSchema,
  type PersonalResearchAnswersRequest,
  type PersonalResearchNavigationRouteDraft,
} from "../../../../lib/api/contracts";

/**
 * DRAFT Personal Research — navigation route input card (§3.5 stage 3).
 *
 * Owner-only typed draft editor for `navigation.route`. Endpoints are
 * existing trip-place ids, not free-text or coordinates: the server
 * resolves them to coordinates against places the owner may actually see,
 * which is what keeps a route request from naming an arbitrary point.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5.
 */

interface NavigationResearchInputCardProps {
  runId: string;
  schemaVersion: number;
  initialDraft?: PersonalResearchNavigationRouteDraft | null;
  onSaved?: (nextSchemaVersion: number, draft: PersonalResearchNavigationRouteDraft) => void;
  onConfirmReady?: (draft: PersonalResearchNavigationRouteDraft) => void;
  saveAnswers(runId: string, input: PersonalResearchAnswersRequest): Promise<void>;
}

const MODES = [
  { value: "driving", label: "驾车" },
  { value: "walking", label: "步行" },
  { value: "cycling", label: "骑行" },
] as const;

export function NavigationResearchInputCard(props: NavigationResearchInputCardProps) {
  const [originPlaceId, setOriginPlaceId] = useState(props.initialDraft?.originPlaceId ?? "");
  const [destinationPlaceId, setDestinationPlaceId] = useState(props.initialDraft?.destinationPlaceId ?? "");
  const [mode, setMode] = useState<PersonalResearchNavigationRouteDraft["mode"]>(props.initialDraft?.mode ?? "driving");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = useCallback(async () => {
    setError(null);
    let draft: PersonalResearchNavigationRouteDraft;
    try {
      draft = personalResearchNavigationRouteDraftSchema.parse({
        kind: "NAVIGATION_ROUTE",
        originPlaceId,
        destinationPlaceId,
        mode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid navigation draft");
      return;
    }
    setSubmitting(true);
    try {
      await props.saveAnswers(props.runId, { schemaVersion: 1 as const, draft });
      props.onSaved?.(props.schemaVersion + 1, draft);
      props.onConfirmReady?.(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save navigation draft");
    } finally {
      setSubmitting(false);
    }
  }, [originPlaceId, destinationPlaceId, mode, props]);

  return (
    <section
      data-testid="navigation-research-input-card"
      data-capability="navigation.route"
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: 12,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <header>
        <h3 style={{ margin: 0, fontSize: 16 }}>查询路线</h3>
        <p style={{ margin: "4px 0 0", color: "var(--color-fg-muted, #6b7280)", fontSize: 13 }}>
          将向 OpenRouteService 发起查询。起点和终点必须是本行程中已有的地点。结果仅你可见且不入共享行程。
        </p>
      </header>

      <TextInput label="起点地点 ID" value={originPlaceId} onChange={setOriginPlaceId} />
      <TextInput label="终点地点 ID" value={destinationPlaceId} onChange={setDestinationPlaceId} />

      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 13 }}>出行方式</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as PersonalResearchNavigationRouteDraft["mode"])}
          style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
        >
          {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>

      {error ? (
        <p data-testid="navigation-research-input-error" role="alert" style={{ color: "var(--color-danger, #b91c1c)" }}>
          {error}
        </p>
      ) : null}

      <footer style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          data-testid="navigation-research-input-submit"
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

function TextInput(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 13 }}>{props.label}</span>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ padding: "6px 8px", border: "1px solid var(--color-border, #d1d5db)", borderRadius: 6 }}
      />
    </label>
  );
}
