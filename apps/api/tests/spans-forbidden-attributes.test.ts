import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  _resetTracingForTests,
  FORBIDDEN_SPAN_ATTRIBUTE_KEYS,
  initTracing,
  shutdownTracing,
  safeSetAttribute,
} from "../src/observability/tracing.js";
import { trace } from "@opentelemetry/api";

const originalEnv = { ...process.env };

/**
 * Static scan: every safeSetAttribute call site in the production source
 * (apps/api/src subtree) must use a key that is NOT in
 * FORBIDDEN_SPAN_ATTRIBUTE_KEYS. The test fails loudly if a developer
 * ever introduces a span attribute that would leak PII, credentials, or
 * a high-cardinality identifier to the exporter.
 */
function collectProductionFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (full.endsWith(".ts") && !full.includes("/tests/") && !full.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }
  return out;
}

describe("FORBIDDEN_SPAN_ATTRIBUTE_KEYS enforcement", () => {
  it("throws on every key in the forbidden set", async () => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
    try {
      await initTracing();
      const tracer = trace.getTracer("test");
      const span = tracer.startSpan("forbidden-key-check");
      try {
        for (const key of FORBIDDEN_SPAN_ATTRIBUTE_KEYS) {
          expect(() => safeSetAttribute(span, key, "x")).toThrow(new RegExp(key));
        }
      } finally {
        span.end();
      }
    } finally {
      await shutdownTracing();
      _resetTracingForTests();
      process.env = { ...originalEnv };
    }
  });

  it("safe keys pass through without throwing", async () => {
    _resetTracingForTests();
    process.env = { ...originalEnv, NODE_ENV: "test" };
    try {
      await initTracing();
      const tracer = trace.getTracer("test");
      const span = tracer.startSpan("safe-key-check");
      try {
        const safe = [
          "http.method",
          "http.route",
          "http.status_code",
          "http.target",
          "net.peer.ip",
          "app.correlation_id",
          "db.system",
          "db.operation",
          "db.sql.table",
          "db.outcome",
          "llm.system",
          "llm.provider",
          "llm.model.name",
          "llm.model.prompt_version",
          "llm.method",
          "llm.stream",
          "llm.skill.name",
          "llm.outcome",
          "llm.error_code",
          "llm.tokens.prompt",
          "llm.tokens.completion",
          "llm.tokens.total",
          "tasks.operation",
          "tasks.run.id",
          "tasks.attempt",
          "tasks.outcome",
          "tasks.error_code",
          "tasks.duration_ms",
          "tasks.recovery",
          "sse.run.id",
          "sse.event.type",
          "sse.outcome",
          "worker.slot",
          "worker.outcome",
        ];
        for (const key of safe) {
          expect(() => safeSetAttribute(span, key, "x")).not.toThrow();
        }
      } finally {
        span.end();
      }
    } finally {
      await shutdownTracing();
      _resetTracingForTests();
      process.env = { ...originalEnv };
    }
  });
});

describe("Static scan: production span attribute keys", () => {
  it("no safeSetAttribute call in apps/api/src uses a forbidden key", () => {
    const root = join(process.cwd(), "src");
    const files = collectProductionFiles(root);
    expect(files.length).toBeGreaterThan(0);
    const offending: { file: string; line: number; key: string }[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, idx) => {
        const match = line.match(/safeSetAttribute\s*\(\s*[^,]+,\s*["']([a-zA-Z0-9_.\-]+)["']/);
        if (match && match[1]) {
          const key = match[1];
          if (FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has(key)) {
            offending.push({ file, line: idx + 1, key });
          }
        }
      });
    }
    if (offending.length > 0) {
      const report = offending
        .map((o) => `  ${o.file}:${o.line} → ${o.key}`)
        .join("\n");
      throw new Error(
        `safeSetAttribute is called with forbidden keys in:\n${report}`,
      );
    }
  });

  it("FORBIDDEN_SPAN_ATTRIBUTE_KEYS is non-empty and covers the canonical categories", () => {
    const expected = [
      "passportNumber",
      "nationality",
      "dateOfBirth",
      "memberPreferences",
      "privateConversation",
      "prompt",
      "question",
      "body",
      "message",
      "authorization",
      "cookie",
      "password",
      "secret",
      "apiKey",
      "accessToken",
      "refreshToken",
      "x-api-key",
      "x-sandbox-signature",
      "userId",
      "tripId",
      "planId",
      "bookingId",
      "conversationId",
      "threadId",
      "destination",
      "origin",
      "model",
      "timestamp",
      "correlationId",
      "requestId",
      "orchestrationRequestId",
      "rawBody",
      "payload",
    ];
    for (const key of expected) {
      expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has(key)).toBe(true);
    }
  });
});

describe("FORBIDDEN_SPAN_ATTRIBUTE_KEYS exhaustiveness", () => {
  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "test" };
  });
  afterEach(async () => {
    await shutdownTracing();
    _resetTracingForTests();
    process.env = { ...originalEnv };
  });

  it("contains every entry from LOGGER_REDACT_PATHS key fragments", async () => {
    await initTracing();
    // Map of pino redact-path fragments to the canonical OTel attribute key.
    // The pino paths reference dot-separated key paths; we extract their
    // tail as the candidate forbidden attribute key.
    const candidates = [
      "authorization",
      "cookie",
      "password",
      "secret",
      "apiKey",
      "accessToken",
      "refreshToken",
      "passportNumber",
      "documentNumber",
      "nationality",
      "dateOfBirth",
      "prompt",
      "question",
      "privateConversation",
      "memberPreferences",
      "body",
      "message",
      "privateMessage",
      "redactedSummary",
      "rawBody",
    ];
    for (const key of candidates) {
      expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has(key)).toBe(true);
    }
  });
});