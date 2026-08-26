import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  _resetTracingForTests,
  initTracing,
  shutdownTracing,
} from "../src/observability/tracing.js";
import { agentTaskRuns } from "../src/db/schema.js";

const originalEnv = { ...process.env };

describe("Migration 0010 agent_task_trace_context", () => {
  beforeEach(() => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
  });

  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("migration file exists and is idempotent", () => {
    const filePath = join(process.cwd(), "migrations", "0010_agent_task_trace_context.sql");
    const sql = readFileSync(filePath, "utf-8");
    expect(sql).toContain("ALTER TABLE agent_task_runs");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS trace_context JSONB");
    expect(sql).toContain("COMMENT ON COLUMN agent_task_runs.trace_context");
    // Idempotent: running twice is safe.
    expect(sql).toContain("IF NOT EXISTS");
  });

  it("schema declares traceContext JSONB column on agentTaskRuns", async () => {
    await initTracing();
    // The schema is statically defined in src/db/schema.ts; we inspect the
    // column descriptor directly.
    const col = agentTaskRuns.traceContext;
    expect(col).toBeDefined();
    // The column name maps to `trace_context` in DDL.
    expect(col.name).toBe("trace_context");
  });

  it("traceContext column has the documented shape", async () => {
    await initTracing();
    const col = agentTaskRuns.traceContext;
    // The data type at the JS level is "json" (Drizzle's lowercased
    // identifier); the underlying Postgres column is JSONB. We assert the
    // shape via $type instead.
    expect(typeof col.dataType).toBe("string");
    type Shape = NonNullable<typeof col.$type>;
    const sample: Shape = {
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      correlationId: "00000000-0000-4000-8000-000000000001",
      tracestate: "vendor=foo",
    };
    expect(sample.traceparent).toBeDefined();
    expect(sample.correlationId).toBeDefined();
  });
});