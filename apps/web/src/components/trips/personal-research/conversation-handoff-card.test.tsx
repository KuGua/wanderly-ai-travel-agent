/**
 * Member conversation handoff — candidate card UI test.
 *
 * Smoke-tests the card with the same fixtures the chat host passes:
 *   - Renders a PENDING candidate row with the catalog fieldKey + value JSON;
 *   - Submit button is disabled when nothing is selected and enabled
 *     otherwise (the card seeds a selection per PENDING proposal by default);
 *   - Confirming fires the mutation; the host receives `onConfirmed` and
 *     drops the card from the message flow.
 *
 * Real network behaviour (catalog / consent / stale / PLAN/REPLAN accept)
 * lives in `apps/api/tests/team-orchestration/conversation-handoff.test.ts`;
 * this file is just the UI surface.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConstraintHandoffBatchResponse, ConstraintHandoffConfirmResponse } from "@/lib/api/contracts";
import type { TravelApi, TravelApiConfiguration } from "@/lib/api";
import { QueryProvider } from "@/lib/query/provider";
import { renderWithIntl } from "@/test/render";
import { ConversationHandoffCard } from "./conversation-handoff-card";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

const SAMPLE_BATCH: ConstraintHandoffBatchResponse = {
  tripId: TRIP_ID,
  batchId: BATCH_ID,
  candidateVersion: 1,
  residualInferenceWarnings: [],
  batch: [
    {
      id: PROPOSAL_ID,
      tripId: TRIP_ID,
      ownerUserId: "owner-id",
      fieldKey: "no_red_eye",
      valueJson: { enabled: true },
      strength: "HARD",
      proposedVisibility: "TEAM_VISIBLE",
      sourceKind: "PERSONAL_AGENT",
      status: "PENDING",
      batchId: BATCH_ID,
      originThreadId: "thread-id",
      originRunId: RUN_ID,
      candidateVersion: 1,
      createdAt: "2026-09-02T12:00:00.000Z",
      resolvedAt: null,
    },
  ],
};

const CONFIRM_RESPONSE: ConstraintHandoffConfirmResponse = {
  runId: "run-id",
  snapshotId: "snapshot-id",
  operation: "PLAN",
  status: "QUEUED",
};

const buildApi = (): TravelApi => ({
  confirmConstraintHandoffBatch: vi.fn(async () => CONFIRM_RESPONSE),
  getConstraintHandoffBatch: vi.fn(async () => SAMPLE_BATCH),
}) as unknown as TravelApi;

const wrap = (ui: React.ReactNode) => {
  const configuration: TravelApiConfiguration = { api: buildApi() };
  return renderWithIntl(<QueryProvider configuration={configuration}>{ui}</QueryProvider>);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationHandoffCard", () => {
  it("renders the catalog field, value, and submit affordance", async () => {
    wrap(<ConversationHandoffCard tripId={TRIP_ID} batch={SAMPLE_BATCH} />);
    expect(screen.getByTestId("conversation-handoff-card")).toBeInTheDocument();
    expect(screen.getByTestId("handoff-candidate-row")).toHaveAttribute("data-field-key", "no_red_eye");
    expect(screen.getByText(/enabled/)).toBeInTheDocument();
    expect(screen.getByTestId("handoff-confirm-button")).toBeEnabled();
  });

  it("calls confirmConstraintHandoffBatch and runs onConfirmed", async () => {
    const onConfirmed = vi.fn();
    const api = buildApi();
    const configuration: TravelApiConfiguration = { api };
    renderWithIntl(
      <QueryProvider configuration={configuration}>
        <ConversationHandoffCard tripId={TRIP_ID} batch={SAMPLE_BATCH} onConfirmed={onConfirmed} />
      </QueryProvider>,
    );
    fireEvent.click(screen.getByTestId("handoff-confirm-button"));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(api.confirmConstraintHandoffBatch).toHaveBeenCalledTimes(1);
    const [calledTripId, calledBatchId, calledInput] = (api.confirmConstraintHandoffBatch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledTripId).toBe(TRIP_ID);
    expect(calledBatchId).toBe(BATCH_ID);
    expect(calledInput.candidateVersion).toBe(1);
    expect(calledInput.selections).toHaveLength(1);
    expect(calledInput.selections[0].proposalId).toBe(PROPOSAL_ID);
  });

  it("fires onDismissed when the user defers the batch", () => {
    const onDismissed = vi.fn();
    wrap(<ConversationHandoffCard tripId={TRIP_ID} batch={SAMPLE_BATCH} onDismissed={onDismissed} />);
    fireEvent.click(screen.getByTestId("handoff-dismiss-button"));
    expect(onDismissed).toHaveBeenCalled();
  });

  it("surfaces a residual-inference warning when the catalog requires it", () => {
    const batch: ConstraintHandoffBatchResponse = {
      ...SAMPLE_BATCH,
      residualInferenceWarnings: ["BUDGET_RESIDUAL_INFERENCE"],
    };
    wrap(<ConversationHandoffCard tripId={TRIP_ID} batch={batch} />);
    expect(screen.getByTestId("residual-inference-warning")).toHaveTextContent(/BUDGET_RESIDUAL_INFERENCE/);
  });
});
