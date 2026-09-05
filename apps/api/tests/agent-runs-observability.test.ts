import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAgentRun } from "../src/observability/agent-runs.js";
import { db } from "../src/db/database.js";
import { pinoInstance } from "../src/observability/telemetry.js";
import { createRequestContext } from "../src/utils/context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent run observability", () => {
  it("writes the derived run and audit event through one transaction", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({ values }));
    const transaction = vi.spyOn(db, "transaction").mockImplementation(
      async (callback) => callback({ insert } as never),
    );

    await expect(recordAgentRun({
      ctx: createRequestContext(),
      skillName: "travel.conversation",
      agentName: "personal",
      modelName: "test-model",
      promptVersion: "test",
      outputHash: "safe-output-hash",
      latencyMs: 12,
      status: "SUCCESS",
    })).resolves.toBe("recorded");

    expect(transaction).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenCalledTimes(2);
  });

  it("does not replace an LLM outcome when its derived telemetry transaction fails", async () => {
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("database unavailable"));

    await expect(recordAgentRun({
      ctx: createRequestContext(),
      skillName: "travel.conversation",
      agentName: "personal",
      modelName: "test-model",
      promptVersion: "test",
      outputHash: "safe-output-hash",
      latencyMs: 12,
      status: "SUCCESS",
      tokens: { prompt: 1, completion: 2, total: 3 },
    })).resolves.toBe("failed");
  });

  it("still preserves the result if the fallback logger is unavailable", async () => {
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("database unavailable"));
    vi.spyOn(pinoInstance, "warn").mockImplementationOnce(() => {
      throw new Error("log sink unavailable");
    });

    await expect(recordAgentRun({
      ctx: createRequestContext(),
      skillName: "travel.conversation",
      agentName: "personal",
      modelName: "test-model",
      promptVersion: "test",
      outputHash: "safe-output-hash",
      latencyMs: 12,
      status: "SUCCESS",
    })).resolves.toBe("failed");
  });
});
