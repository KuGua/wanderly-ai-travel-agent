import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { LOGGER_REDACTION } from "../src/observability/telemetry.js";
import { MetricLabelError, metrics } from "../src/observability/metrics.js";

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
});

describe("bounded metrics", () => {
  it("emits only expected bounded callback and provider labels", () => {
    metrics.inc("callback_verifications_total", { callbackResult: "valid" });
    metrics.observe("llm_request_latency_ms", 10, { provider: "gemini", outcome: "success" });

    const rendered = metrics.render();
    expect(rendered).toContain('callbackResult="valid"');
    expect(rendered).toContain('provider="gemini"');
    expect(rendered).toContain('outcome="success"');
  });

  it("rejects high-cardinality keys and free-form values before emission", () => {
    const identifier = "trip-7ce24d3b-7b99-41e9-a350-8a1d5e6de555";

    expect(() => metrics.inc("callback_verifications_total", {
      callbackResult: "valid",
      tripId: identifier,
    })).toThrow(MetricLabelError);
    expect(() => metrics.observe("llm_request_latency_ms", 10, {
      provider: "arbitrary-model-name",
      outcome: "success",
    })).toThrow(MetricLabelError);
    expect(metrics.render()).not.toContain(identifier);
    expect(metrics.render()).not.toContain("arbitrary-model-name");
  });
});
