import { describe, expect, it, vi } from "vitest";

import { runLlmSuggestEnvelope } from "../src/services/llm-suggest-envelope.js";
import { SkillError } from "../src/agents/errors.js";
import type { RequestContext } from "../src/utils/context.js";

const ctx = { correlationId: "test-correlation" } as unknown as RequestContext;

describe("runLlmSuggestEnvelope", () => {
  it("returns the postprocessed value, never the model's raw output", async () => {
    // The regression this guards: the envelope used to return `raw`, so a
    // caller that canonicalises inside `postprocess` silently persisted the
    // model's own text. A zh caller whose model answers "France" must get
    // 法国 back.
    const result = await runLlmSuggestEnvelope<{ value: string }, { value: string }>({
      ctx,
      operation: "test.op",
      invoke: async () => ({ value: "France" }),
      postprocess: () => ({ ok: true, value: { value: "法国" } }),
    });
    expect(result).toEqual({ ok: true, output: { value: "法国" } });
  });

  it("hands the raw output to postprocess unchanged", async () => {
    const postprocess = vi.fn().mockReturnValue({ ok: true, value: "cleaned" });
    await runLlmSuggestEnvelope<{ kind: string; value: string }, string>({
      ctx,
      operation: "test.op",
      invoke: async () => ({ kind: "COUNTRY", value: "  fRaNcE  " }),
      postprocess,
    });
    expect(postprocess).toHaveBeenCalledWith({ kind: "COUNTRY", value: "  fRaNcE  " });
  });

  it("maps a fail-closed postprocess to REJECTED", async () => {
    const result = await runLlmSuggestEnvelope<string, string>({
      ctx,
      operation: "test.op",
      invoke: async () => "not a place",
      postprocess: () => ({ ok: false }),
    });
    expect(result).toEqual({ ok: false, reason: "REJECTED" });
  });

  it("maps a skill failure to UNAVAILABLE and reports the error code", async () => {
    const onUnavailable = vi.fn();
    const result = await runLlmSuggestEnvelope<string, string>({
      ctx,
      operation: "test.op",
      invoke: async () => { throw new SkillError("TIMEOUT", "gateway timed out"); },
      postprocess: () => ({ ok: true, value: "unreachable" }),
      onUnavailable,
    });
    expect(result).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(onUnavailable).toHaveBeenCalledWith("TIMEOUT");
  });

  it("maps a non-SkillError throw to UNAVAILABLE as UPSTREAM_FAILURE", async () => {
    const onUnavailable = vi.fn();
    const result = await runLlmSuggestEnvelope<string, string>({
      ctx,
      operation: "test.op",
      invoke: async () => { throw new TypeError("boom"); },
      postprocess: () => ({ ok: true, value: "unreachable" }),
      onUnavailable,
    });
    expect(result).toEqual({ ok: false, reason: "UNAVAILABLE" });
    expect(onUnavailable).toHaveBeenCalledWith("UPSTREAM_FAILURE");
  });

  it("treats a postprocess throw as UNAVAILABLE rather than crashing the route", async () => {
    const result = await runLlmSuggestEnvelope<string, string>({
      ctx,
      operation: "test.op",
      invoke: async () => "France",
      postprocess: () => { throw new Error("reference dataset unreadable"); },
    });
    expect(result).toEqual({ ok: false, reason: "UNAVAILABLE" });
  });
});
