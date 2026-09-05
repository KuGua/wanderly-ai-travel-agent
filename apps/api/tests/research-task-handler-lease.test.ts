import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../src/tasks/personal-trip-orchestrator-service.js", () => ({
  runResearch: vi.fn(),
  pinSessionIfTerminal: vi.fn().mockResolvedValue({ written: false }),
}));
vi.mock("../src/tasks/task-stream-publisher.js", () => ({
  publishAgentStreamEvent: vi.fn().mockResolvedValue(undefined),
}));

import { runResearch } from "../src/tasks/personal-trip-orchestrator-service.js";
import { handleResearchTask } from "../src/tasks/handlers/research-task-handler.js";
import { createRequestContext } from "../src/utils/context.js";
import type { AgentTaskRow } from "../src/tasks/task-repository.js";

/**
 * `generatePlan` refuses to write anything — plan or research summary —
 * without the Worker's lease. The handler held one and did not pass it on, so
 * a PROPOSE_PLAN round produced neither. The unit test for the degrade called
 * `generatePlan` directly with a lease and was green throughout; nothing
 * covered the seam where the token was actually dropped.
 */
describe("research task handler lease authority", () => {
  beforeEach(() => {
    vi.mocked(runResearch).mockReset();
    vi.mocked(runResearch).mockResolvedValue({ outcome: "COMPLETED", researchResultId: randomUUID() });
  });
  afterEach(() => vi.restoreAllMocks());

  it("hands its lease token to the orchestrator", async () => {
    const leaseToken = randomUUID();
    const run = {
      id: randomUUID(), operation: "RESEARCH", tripId: randomUUID(), snapshotId: randomUUID(),
      generationAttempt: 0, createdByUserId: randomUUID(),
    } as unknown as AgentTaskRow;

    // The handler finalises the run against the database afterwards, which
    // this fixture has no rows for. Everything under test happens before that,
    // so let the finalisation fail rather than build a whole trip to satisfy it.
    await handleResearchTask({ run, ctx: createRequestContext(), signal: new AbortController().signal, leaseToken })
      .catch(() => undefined);

    expect(runResearch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runResearch).mock.calls[0][0]).toMatchObject({ leaseToken });
  });
});
