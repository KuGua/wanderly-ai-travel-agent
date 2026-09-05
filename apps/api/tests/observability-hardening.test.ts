import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDailyRotatingLogStream,
  LOGGER_REDACTION,
  localDebugLogDate,
  pruneLocalDebugLogs,
  resolveLocalDebugLogPath,
  type LocalLogDescriptor,
} from "../src/observability/telemetry.js";
import { MetricLabelError, metrics } from "../src/observability/metrics.js";
import { observeExternalProviderFetch } from "../src/observability/external-provider.js";

afterEach(() => {
  metrics.reset();
});

describe("logger redaction", () => {
  it("redacts credentials, callback signatures, document data, and private model input", () => {
    const lines: string[] = [];
    const logger = pino(
      { level: "info", redact: LOGGER_REDACTION },
      { write: (line: string) => lines.push(line) },
    );

    logger.warn({
      correlationId: "safe-correlation",
      req: {
        headers: {
          authorization: "Bearer credential",
          cookie: "session=credential",
          "x-api-key": "provider-key",
          "x-sandbox-signature": "signed-secret",
        },
        body: {
          passportNumber: "P1234567",
          nationality: "private-nationality",
          memberPreferences: { private: "preference" },
        },
      },
    }, "Callback rejected");

    const output = lines.join("");
    expect(output).toContain("safe-correlation");
    expect(output).toContain("[REDACTED]");
    for (const secret of [
      "Bearer credential",
      "session=credential",
      "provider-key",
      "signed-secret",
      "P1234567",
      "private-nationality",
      "preference",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("rotates local diagnostic files by the configured calendar day", () => {
    const august31 = new Date("2026-08-31T15:59:00.000Z");
    const september1 = new Date("2026-08-31T16:01:00.000Z");
    expect(localDebugLogDate(august31, "Asia/Singapore")).toBe("2026-08-31");
    expect(localDebugLogDate(september1, "Asia/Singapore")).toBe("2026-09-01");
    expect(resolveLocalDebugLogPath("agent-runtime.ndjson", august31)).toMatch(/[\\/]runtime[\\/]agent-2026-08-31\.ndjson$/);
    expect(resolveLocalDebugLogPath("auto", august31)).toMatch(/[\\/]runtime[\\/]api-2026-08-31\.ndjson$/);
    expect(() => resolveLocalDebugLogPath("../secrets.ndjson")).toThrow('"auto" or a simple .ndjson filename');
    expect(() => resolveLocalDebugLogPath("C:\\temp\\events.ndjson")).toThrow('"auto" or a simple .ndjson filename');
    expect(() => resolveLocalDebugLogPath("events.log")).toThrow('"auto" or a simple .ndjson filename');
  });

  it("switches files at midnight and retains only the most recent seven dated files on startup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-travel-agent-logs-"));
    const descriptor: LocalLogDescriptor = { directory, prefix: "api", timeZone: "Asia/Singapore" };
    try {
      writeFileSync(join(directory, "api-2026-08-25.ndjson"), "expired\n");
      writeFileSync(join(directory, "api-2026-08-26.ndjson"), "retained\n");
      writeFileSync(join(directory, "worker-2026-08-01.ndjson"), "other-role\n");
      pruneLocalDebugLogs(descriptor, new Date("2026-09-01T01:00:00.000+08:00"));
      expect(() => readFileSync(join(directory, "api-2026-08-25.ndjson"))).toThrow();
      expect(readFileSync(join(directory, "api-2026-08-26.ndjson"), "utf8")).toBe("retained\n");
      expect(readFileSync(join(directory, "worker-2026-08-01.ndjson"), "utf8")).toBe("other-role\n");

      let now = new Date("2026-08-31T15:59:00.000Z");
      const stream = createDailyRotatingLogStream(descriptor, () => now);
      await write(stream, "before-midnight\n");
      now = new Date("2026-08-31T16:01:00.000Z");
      await write(stream, "after-midnight\n");
      stream.destroy();

      expect(readFileSync(join(directory, "api-2026-08-31.ndjson"), "utf8")).toBe("before-midnight\n");
      expect(readFileSync(join(directory, "api-2026-09-01.ndjson"), "utf8")).toBe("after-midnight\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function write(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(line, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

describe("bounded metrics", () => {
  it("records only bounded metadata for outbound provider HTTP calls", async () => {
    const response = await observeExternalProviderFetch(
      { provider: "nuitee_connect", operation: "hotel.search", method: "POST" },
      async () => new Response("private provider response", {
        status: 200,
        headers: { "content-length": "25" },
      }),
    );

    expect(response.status).toBe(200);
    const rendered = metrics.render();
    expect(rendered).toContain('external_provider_http_calls_total{operation="hotel.search",outcome="success",provider="nuitee_connect"} 1');
    expect(rendered).not.toContain("private provider response");
  });

  it("classifies an aborted outbound call without retaining the exception text", async () => {
    await expect(observeExternalProviderFetch(
      { provider: "openrouteservice", operation: "place.search", method: "GET" },
      async () => { throw new DOMException("private upstream response", "AbortError"); },
    )).rejects.toThrow("private upstream response");

    expect(metrics.render()).toContain('external_provider_http_calls_total{operation="place.search",outcome="failure",provider="openrouteservice"} 1');
  });

  it("emits only expected bounded callback and model-provider labels", () => {
    metrics.inc("callback_verifications_total", { callbackResult: "valid" });
    metrics.observe("llm_request_latency_ms", 125, { provider: "gemini", outcome: "success" });

    const rendered = metrics.render();
    expect(rendered).toContain('callbackResult="valid"');
    expect(rendered).toContain('provider="gemini"');
    expect(rendered).toContain('outcome="success"');
  });

  it("accepts the configured SerpAPI provider for live and unavailable flight Tool outcomes", () => {
    expect(() => metrics.inc("flight_tool_invocations_total", {
      outcome: "live",
      provider: "serpapi",
      error_category: "none",
    })).not.toThrow();
    expect(() => metrics.inc("flight_tool_invocations_total", {
      outcome: "unavailable",
      provider: "serpapi",
      error_category: "upstream_failure",
    })).not.toThrow();

    const rendered = metrics.render();
    expect(rendered).toContain('provider="serpapi"');
  });

  it("rejects high-cardinality keys and free-form values before emission", () => {
    const identifier = "trip-7ce24d3b-7b99-41e9-a350-8a1d5e6de555";

    expect(() => metrics.inc("callback_verifications_total", {
      callbackResult: "valid",
      tripId: identifier,
    })).toThrow(MetricLabelError);
    expect(() => metrics.observe("llm_request_latency_ms", 125, {
      provider: "arbitrary-model-name",
      outcome: "success",
    })).toThrow(MetricLabelError);
    expect(metrics.render()).not.toContain(identifier);
    expect(metrics.render()).not.toContain("arbitrary-model-name");
  });

  it("accepts rate_limited for llm_request_errors_total (closes the 429 metric regression)", () => {
    expect(() => metrics.inc("llm_request_errors_total", {
      provider: "openai",
      error_category: "rate_limited",
      retryable: "true",
    })).not.toThrow();
    expect(() => metrics.inc("llm_request_errors_total", {
      provider: "gemini",
      error_category: "rate_limited",
      retryable: "false",
    })).not.toThrow();
    expect(() => metrics.inc("llm_request_errors_total", {
      provider: "openai-compatible",
      error_category: "rate_limited",
      retryable: "true",
    })).not.toThrow();
    const rendered = metrics.render();
    expect(rendered).toContain('error_category="rate_limited"');
    // The first two increments share the same (provider, error_category, retryable) tuple.
    // A different retryable label must still be emitted as its own series.
    expect(rendered).toMatch(/(rate_limited.*retryable="true"|retryable="true".*rate_limited)/);
  });

  it("still rejects any free-form error_category value to keep the label set bounded", () => {
    expect(() => metrics.inc("llm_request_errors_total", {
      provider: "openai",
      error_category: "wat",
      retryable: "true",
    })).toThrow(MetricLabelError);
    // Future-proofing: must not silently accept arbitrary lowercase strings
    // such as `code.toLowerCase()` of an internal error code outside the union.
    expect(() => metrics.inc("llm_request_errors_total", {
      provider: "openai",
      error_category: "tool_call_max_turns",
      retryable: "true",
    })).toThrow(MetricLabelError);
  });

  it("describes every registered series so docs:verify can diff the registry", () => {
    const described = metrics.describe();
    const names = described.map(series => series.name);

    // Sorted output keeps generated documentation diffs stable.
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(names).size).toBe(names.length);

    // Every series `/metrics` can render must be describable, or the doc check
    // would silently stop covering it.
    const rendered = metrics.render()
      .split("\n")
      .filter(line => line.startsWith("# TYPE "))
      .map(line => line.split(" ")[2]);
    expect(new Set(rendered)).toEqual(new Set(names));

    const callback = described.find(series => series.name === "callback_verifications_total");
    expect(callback).toMatchObject({ type: "counter" });
    expect(callback?.allowedLabels.callbackResult).toContain("bad_signature");
    expect(callback?.buckets).toBeUndefined();

    const latency = described.find(series => series.name === "llm_request_latency_ms");
    expect(latency).toMatchObject({ type: "histogram" });
    expect(latency?.buckets?.[0]).toBe(50);
  });
});
