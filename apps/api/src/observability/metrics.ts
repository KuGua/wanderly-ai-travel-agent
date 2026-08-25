/**
 * In-process MVP metrics registry. It exposes Prometheus text at `/metrics`, but
 * deliberately provides no production exporter or durable metrics storage.
 * Every series has a fixed label schema and bounded value allow-list.
 */

type LabelKey = string;
type Sample = number;
type AllowedLabels = Readonly<Record<string, readonly string[]>>;

interface CounterSeries {
  type: "counter";
  help: string;
  allowedLabels: AllowedLabels;
  samples: Map<LabelKey, Sample>;
}

interface HistogramSeries {
  type: "histogram";
  help: string;
  allowedLabels: AllowedLabels;
  buckets: number[];
  counts: Map<LabelKey, Map<string, number>>;
  sums: Map<LabelKey, number>;
  totals: Map<LabelKey, number>;
}

type Series = CounterSeries | HistogramSeries;

const FORBIDDEN_LABEL_KEYS = new Set([
  "userId", "tripId", "planId", "bookingId", "correlationId", "requestId",
  "orchestrationRequestId", "message", "timestamp", "name", "nationality",
  "destination", "origin", "model",
  // Defense in depth: per PRD FR-7.3, conversationId (and its runtime
  // alias threadId) must never appear as a metric label.
  "conversationId", "threadId",
]);

export type MetricProvider = "openai" | "gemini" | "openai-compatible";

export class MetricLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricLabelError";
  }
}

function labelKey(labels: Record<string, string>): LabelKey {
  return Object.keys(labels)
    .sort()
    .map(key => `${key}=${JSON.stringify(labels[key])}`)
    .join(",");
}

function labelsWithLe(key: LabelKey, bucket: number | "+Inf"): string {
  return `{${key ? `${key},` : ""}le=${JSON.stringify(String(bucket))}}`;
}

export class MetricsRegistry {
  private series = new Map<string, Series>();

  registerCounter(name: string, help: string, allowedLabels: AllowedLabels = {}): void {
    if (!this.series.has(name)) {
      this.series.set(name, { type: "counter", help, allowedLabels, samples: new Map() });
    }
  }

  registerHistogram(
    name: string,
    help: string,
    buckets: number[],
    allowedLabels: AllowedLabels = {},
  ): void {
    if (!this.series.has(name)) {
      this.series.set(name, {
        type: "histogram",
        help,
        allowedLabels,
        buckets,
        counts: new Map(),
        sums: new Map(),
        totals: new Map(),
      });
    }
  }

  private validatedLabelKey(name: string, series: Series, labels: Record<string, string> = {}): LabelKey {
    const suppliedKeys = Object.keys(labels).sort();
    const expectedKeys = Object.keys(series.allowedLabels).sort();
    if (suppliedKeys.some(key => FORBIDDEN_LABEL_KEYS.has(key))) {
      throw new MetricLabelError(`Metric ${name} received a forbidden high-cardinality label`);
    }
    if (suppliedKeys.join(",") !== expectedKeys.join(",")) {
      throw new MetricLabelError(`Metric ${name} labels must be exactly: ${expectedKeys.join(", ") || "none"}`);
    }
    for (const key of expectedKeys) {
      if (!series.allowedLabels[key].includes(labels[key])) {
        throw new MetricLabelError(`Metric ${name} received an unbounded value for ${key}`);
      }
    }
    return labelKey(labels);
  }

  inc(name: string, labels?: Record<string, string>, n: number = 1): void {
    const series = this.series.get(name);
    if (!series || series.type !== "counter") {
      throw new Error(`Counter metric is not registered: ${name}`);
    }
    const key = this.validatedLabelKey(name, series, labels);
    series.samples.set(key, (series.samples.get(key) ?? 0) + n);
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    const series = this.series.get(name);
    if (!series || series.type !== "histogram") {
      throw new Error(`Histogram metric is not registered: ${name}`);
    }
    const key = this.validatedLabelKey(name, series, labels);
    if (!series.counts.has(key)) series.counts.set(key, new Map());
    const bucketMap = series.counts.get(key)!;
    for (const bucket of series.buckets) {
      if (value <= bucket) {
        const label = String(bucket);
        bucketMap.set(label, (bucketMap.get(label) ?? 0) + 1);
      }
    }
    bucketMap.set("+Inf", (bucketMap.get("+Inf") ?? 0) + 1);
    series.sums.set(key, (series.sums.get(key) ?? 0) + value);
    series.totals.set(key, (series.totals.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, series] of this.series) {
      lines.push(`# HELP ${name} ${series.help}`);
      lines.push(`# TYPE ${name} ${series.type}`);
      if (series.type === "counter") {
        if (series.samples.size === 0) {
          lines.push(`${name} 0`);
          continue;
        }
        for (const [key, value] of series.samples) {
          lines.push(key ? `${name}{${key}} ${value}` : `${name} ${value}`);
        }
        continue;
      }

      if (series.counts.size === 0) {
        lines.push(`${name}_count 0`);
        lines.push(`${name}_sum 0`);
        continue;
      }
      for (const [key, bucketMap] of series.counts) {
        for (const bucket of series.buckets) {
          lines.push(`${name}_bucket${labelsWithLe(key, bucket)} ${bucketMap.get(String(bucket)) ?? 0}`);
        }
        lines.push(`${name}_bucket${labelsWithLe(key, "+Inf")} ${bucketMap.get("+Inf") ?? 0}`);
        const labelSuffix = key ? `{${key}}` : "";
        lines.push(`${name}_count${labelSuffix} ${series.totals.get(key) ?? 0}`);
        lines.push(`${name}_sum${labelSuffix} ${series.sums.get(key) ?? 0}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  reset(): void {
    for (const series of this.series.values()) {
      if (series.type === "counter") series.samples.clear();
      else {
        series.counts.clear();
        series.sums.clear();
        series.totals.clear();
      }
    }
  }
}

export const metrics = new MetricsRegistry();

metrics.registerCounter("agent_skill_runs_total", "Total skill invocations by bounded outcome.", {
  operation: ["profile", "consent", "research", "readiness", "planning", "review", "confirmation", "booking"],
  outcome: ["success", "failure", "rejected", "timeout"],
});
metrics.registerCounter("plan_validation_failures_total", "Plan validation failures by bounded result.", {
  validationResult: ["schema", "authorization", "route", "provenance", "evidence", "unknown"],
});
metrics.registerCounter("booking_gate_denials_total", "Booking gate denials by bounded category.", {
  errorCategory: ["callback_auth", "membership", "quorum", "plan_state", "unknown"],
});
metrics.registerCounter("callback_verifications_total", "Sandbox callback signature verification results.", {
  callbackResult: [
    "valid", "missing_header", "malformed_timestamp", "expired", "bad_signature", "configuration_error",
  ],
});
metrics.registerCounter("booking_callback_outcomes_total", "Authenticated booking callback outcomes.", {
  callbackResult: ["processed", "duplicate", "failed"],
});
metrics.registerHistogram(
  "llm_request_latency_ms",
  "Latency of successful LLM requests in milliseconds.",
  [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000],
  {
    provider: ["openai", "gemini", "openai-compatible"],
    outcome: ["success"],
  },
);

export type Metrics = typeof metrics;
