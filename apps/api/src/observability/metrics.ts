/**
 * Tiny in-process metrics module. Avoids pulling in `prom-client` for the MVP;
 * exposes the four counter series called out in agent-architecture.md §9 plus a
 * latency histogram, and renders Prometheus text format on demand. Low cardinality
 * only — labels are concatenated in alphabetical order.
 */

type LabelKey = string;
type Sample = number;

interface CounterSeries {
  type: "counter";
  help: string;
  samples: Map<LabelKey, Sample>;
}

interface HistogramSeries {
  type: "histogram";
  help: string;
  buckets: number[];
  counts: Map<LabelKey, Map<string, number>>; // bucket key "<=N" → count
  sums: Map<LabelKey, number>;
  totals: Map<LabelKey, number>;
}

type Series = CounterSeries | HistogramSeries;

function labelKey(labels?: Record<string, string>): LabelKey {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  return keys.map(k => `${k}=${labels[k]}`).join(",");
}

class MetricsRegistry {
  private series = new Map<string, Series>();

  registerCounter(name: string, help: string): void {
    if (!this.series.has(name)) {
      this.series.set(name, { type: "counter", help, samples: new Map() });
    }
  }

  registerHistogram(name: string, help: string, buckets: number[]): void {
    if (!this.series.has(name)) {
      this.series.set(name, {
        type: "histogram",
        help,
        buckets,
        counts: new Map(),
        sums: new Map(),
        totals: new Map(),
      });
    }
  }

  inc(name: string, labels?: Record<string, string>, n: number = 1): void {
    const series = this.series.get(name);
    if (!series || series.type !== "counter") return;
    const key = labelKey(labels);
    series.samples.set(key, (series.samples.get(key) ?? 0) + n);
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    const series = this.series.get(name);
    if (!series || series.type !== "histogram") return;
    const key = labelKey(labels);
    if (!series.counts.has(key)) series.counts.set(key, new Map());
    const bucketMap = series.counts.get(key)!;
    for (const bucket of series.buckets) {
      const label = `<=${bucket}`;
      if (value <= bucket) {
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
      if (series.type === "counter") {
        lines.push(`# HELP ${name} ${series.help}`);
        lines.push(`# TYPE ${name} counter`);
        if (series.samples.size === 0) {
          lines.push(`${name} 0`);
          continue;
        }
        for (const [key, value] of series.samples) {
          lines.push(key ? `${name}{${key}} ${value}` : `${name} ${value}`);
        }
      } else {
        lines.push(`# HELP ${name} ${series.help}`);
        lines.push(`# TYPE ${name} histogram`);
        if (series.counts.size === 0) {
          lines.push(`${name}_count 0`);
          lines.push(`${name}_sum 0`);
          continue;
        }
        for (const [key, bucketMap] of series.counts) {
          const labelSuffix = key ? `{${key}}` : "";
          for (const bucket of series.buckets) {
            const label = `<=${bucket}`;
            const count = bucketMap.get(label) ?? 0;
            lines.push(`${name}_bucket${labelSuffix.replace("}", `,le="${bucket}"}`)} ${count}`);
          }
          lines.push(`${name}_bucket${labelSuffix.replace("}", ',le="+Inf"}')} ${bucketMap.get("+Inf") ?? 0}`);
          lines.push(`${name}_count${labelSuffix} ${series.totals.get(key) ?? 0}`);
          lines.push(`${name}_sum${labelSuffix} ${series.sums.get(key) ?? 0}`);
        }
      }
    }
    return lines.join("\n") + "\n";
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

metrics.registerCounter(
  "agent_skill_runs_total",
  "Total skill invocations bucketed by agent, skill, and result.",
);
metrics.registerCounter(
  "plan_validation_failures_total",
  "Plan output validation failures bucketed by reason.",
);
metrics.registerCounter(
  "provider_fallback_total",
  "Provider fallback events bucketed by provider and outcome.",
);
metrics.registerCounter(
  "booking_gate_denials_total",
  "Booking gate denials bucketed by reason (auth, signature, quorum, etc.).",
);
metrics.registerHistogram(
  "llm_request_latency_ms",
  "Latency of LLM requests in milliseconds.",
  [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000],
);

export type Metrics = typeof metrics;