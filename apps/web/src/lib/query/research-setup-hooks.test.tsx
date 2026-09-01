import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TravelApi } from "@/lib/api/travel-api";
import { QueryProvider } from "./provider";
import {
  useCancelResearchSetup,
  useConfirmResearchSetup,
  useDismissResearchIntent,
  useOpenResearchSetup,
  useSaveResearchSetupAnswer,
} from "./hooks";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const TRIP_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

function Probe() {
  const dismiss = useDismissResearchIntent(RUN_ID);
  const open = useOpenResearchSetup(RUN_ID);
  const save = useSaveResearchSetupAnswer(RUN_ID);
  const cancel = useCancelResearchSetup(RUN_ID);
  const confirm = useConfirmResearchSetup(RUN_ID, TRIP_ID);

  return (
    <>
      <button onClick={() => dismiss.mutate()}>dismiss</button>
      <button onClick={() => open.mutate()}>open</button>
      <button onClick={() => save.mutate({
        expectedVersion: 1,
        patch: { field: "travelDates", value: { start: "2026-10-12", end: "2026-10-15" } },
      })}>save</button>
      <button onClick={() => cancel.mutate()}>cancel</button>
      <button onClick={() => confirm.mutate({ requestId: REQUEST_ID })}>confirm</button>
    </>
  );
}

describe("conversational research setup mutation hooks", () => {
  it("calls optional transport methods with the API instance as this", async () => {
    const calls: string[] = [];
    const api = {
      marker: "transport",
      dismissResearchIntent(this: { marker: string }, runId: string) {
        expect(this.marker).toBe("transport");
        calls.push(`dismiss:${runId}`);
        return Promise.resolve();
      },
      openResearchSetup(this: { marker: string }, runId: string) {
        expect(this.marker).toBe("transport");
        calls.push(`open:${runId}`);
        return Promise.resolve({ session: session() });
      },
      saveResearchSetupAnswer(this: { marker: string }, runId: string) {
        expect(this.marker).toBe("transport");
        calls.push(`save:${runId}`);
        return Promise.resolve({ session: session() });
      },
      cancelResearchSetup(this: { marker: string }, runId: string) {
        expect(this.marker).toBe("transport");
        calls.push(`cancel:${runId}`);
        return Promise.resolve({ status: "CANCELLED" as const });
      },
      confirmResearchSetup(this: { marker: string }, runId: string) {
        expect(this.marker).toBe("transport");
        calls.push(`confirm:${runId}`);
        return Promise.resolve({ runId: RUN_ID, snapshotId: REQUEST_ID, status: "QUEUED" as const });
      },
    } as unknown as TravelApi;

    render(<Probe />, {
      wrapper: ({ children }) => <QueryProvider configuration={{ api }}>{children}</QueryProvider>,
    });

    for (const label of ["dismiss", "open", "save", "cancel", "confirm"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }

    await waitFor(() => {
      expect(calls).toEqual([
        `dismiss:${RUN_ID}`,
        `open:${RUN_ID}`,
        `save:${RUN_ID}`,
        `cancel:${RUN_ID}`,
        `confirm:${RUN_ID}`,
      ]);
    });
  });
});

function session() {
  return {
    intentRunId: RUN_ID,
    tripId: TRIP_ID,
    ownerUserId: "44444444-4444-4444-8444-444444444444",
    departureCity: null,
    travelDateStart: null,
    travelDateEnd: null,
    stayPreferences: null,
    flightPreferences: null,
    missing: ["DATES_MISSING"] as const,
    version: 1,
    status: "OPEN" as const,
    expiresAt: "2026-10-01T00:00:00.000Z",
  };
}
