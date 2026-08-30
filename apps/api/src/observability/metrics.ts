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

interface GaugeSeries {
  type: "gauge";
  help: string;
  allowedLabels: AllowedLabels;
  values: Map<LabelKey, Sample>;
}

type Series = CounterSeries | HistogramSeries | GaugeSeries;

const FORBIDDEN_LABEL_KEYS = new Set([
  "userId", "tripId", "planId", "bookingId", "correlationId", "requestId",
  "orchestrationRequestId", "message", "timestamp", "name", "nationality",
  "destination", "origin", "model",
  // Defense in depth: per PRD FR-7.3, conversationId (and its runtime
  // alias threadId) must never appear as a metric label.
  "conversationId", "threadId",
  // S4 location-introduction cache: identifiers, generated content and
  // coordinates must never appear as metric labels (PRD §5.11, AGENTS.md).
  "sourceId", "placeName", "canonicalPlaceId", "cacheKey",
  "content", "generatedContent",
  "latitude", "longitude", "coordinates",
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

  /**
   * Register a Prometheus-style gauge series. Used for sampled aggregate
   * counts that can move in either direction (e.g. cache row counts).
   * Allowed labels follow the same allow-list / forbidden-key rules as
   * counters and histograms.
   */
  registerGauge(name: string, help: string, allowedLabels: AllowedLabels = {}): void {
    if (!this.series.has(name)) {
      this.series.set(name, { type: "gauge", help, allowedLabels, values: new Map() });
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

  /**
   * Replace the gauge sample for the given labels. Gauges are sampled at
   * observation time and may move in either direction. Calling `setGauge`
   * without a prior `registerGauge` throws — gauges are not implicitly
   * auto-created so a typo cannot silently grow the registry.
   */
  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    const series = this.series.get(name);
    if (!series || series.type !== "gauge") {
      throw new Error(`Gauge metric is not registered: ${name}`);
    }
    if (!Number.isFinite(value)) {
      throw new Error(`setGauge(${name}) received a non-finite value`);
    }
    const key = this.validatedLabelKey(name, series, labels);
    series.values.set(key, value);
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
      if (series.type === "gauge") {
        if (series.values.size === 0) {
          lines.push(`${name} 0`);
          continue;
        }
        for (const [key, value] of series.values) {
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
      else if (series.type === "gauge") series.values.clear();
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
metrics.registerCounter("location_reference_requests_total", "Offline map location references by bounded outcome.", {
  outcome: ["reference", "no_reference", "unavailable", "rate_limited"],
});

// S4 / docs/location-introduction-cache-implementation.md §9. Anonymous
// location-introduction requests by bounded outcome, generation latency,
// and aggregate cache row counts. Identifiers (sourceId, canonicalPlaceId,
// cacheKey, content, coordinates) are forbidden label keys and must never
// appear here — see FORBIDDEN_LABEL_KEYS above.
metrics.registerCounter("location_introduction_requests_total", "Anonymous location-introduction requests by bounded outcome.", {
  outcome: ["hit", "miss", "generating", "unsupported", "rate_limited", "unavailable"],
});
metrics.registerHistogram(
  "location_introduction_generation_duration_ms",
  "Location-introduction generation latency in milliseconds.",
  [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000],
  {
    outcome: ["success", "failure"],
  },
);
metrics.registerGauge("location_introduction_cache_entries", "Aggregate location-introduction cache row counts.", {
  status: ["ready", "generating"],
});
metrics.registerCounter("location_introduction_registry_total", "Operator registration outcomes for the location-introduction catalog.", {
  outcome: ["registered", "duplicate", "error"],
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
metrics.registerCounter("agent_task_outcomes_total", "Durable Agent task outcomes by bounded operation and result.", {
  operation: ["conversation", "plan", "replan"],
  outcome: ["completed", "failed", "cancelled", "retrying"],
});
metrics.registerCounter("exploration_start_total", "Exploration-start idempotency outcomes.", {
  result: ["created", "cached", "conflict", "error"],
});
metrics.registerCounter("trip_activation_total", "Draft Trip activation outcomes.", {
  result: ["success", "conflict", "forbidden", "invalid", "error"],
});
metrics.registerCounter("trip_draft_brief_update_total", "Creator-confirmed DRAFT brief updates.", {
  result: ["success"],
});
metrics.registerCounter("draft_command_rejected_total", "Collaboration commands rejected because the Trip is still a Draft.", {
  operation: ["invitation", "consent", "planning", "confirmation", "booking", "change_event"],
});
metrics.registerCounter("agent_task_recoveries_total", "Expired Agent task leases and queue entries recovered.", {
  outcome: ["retrying", "failed", "cancelled"],
});
metrics.registerCounter("flight_provider_requests_total", "Flight provider requests by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["amadeus", "flightapi"],
  error_category: ["none", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "no_results"],
});
metrics.registerHistogram("flight_provider_latency_ms", "Flight provider latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 8_000, 15_000], {
  provider: ["amadeus", "flightapi"],
  outcome: ["live", "unavailable"],
});
metrics.registerCounter("flight_tool_invocations_total", "Flight tool execution outcomes.", {
  outcome: ["live", "unavailable"],
  provider: ["amadeus", "flightapi", "unconfigured"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
// Global POI & ground mobility (docs/ground-mobility-implementation.md §7).
// All label sets are bounded enums; identifiers (trip_id / run_id /
// place_id / route_id) live only in trace/log correlation context.
metrics.registerCounter("place_provider_requests_total", "ORS Place provider requests by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["openrouteservice"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
metrics.registerHistogram("place_provider_latency_ms", "ORS Place provider latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 8_000, 15_000], {
  provider: ["openrouteservice"],
  outcome: ["live", "unavailable"],
});
metrics.registerCounter("place_search_tool_invocations_total", "places.search skill execution outcomes.", {
  outcome: ["live", "unavailable"],
  provider: ["openrouteservice"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved", "policy_denied", "per_run_cap_exceeded"],
});
metrics.registerCounter("trip_place_actions_total", "Server-authoritative TripPlace lifecycle actions.", {
  action: ["proposed", "adopted", "revoked", "stale_invalidated"],
  visibility: ["owner_private", "team_visible", "orchestrator_confidential"],
});

// Global POI & ground mobility — navigation (docs/ground-mobility-implementation.md §7).
metrics.registerCounter("navigation_provider_requests_total", "ORS navigation provider requests by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["openrouteservice"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
  transport_mode: ["walk", "drive", "cycle", "any"],
});
metrics.registerHistogram("navigation_provider_latency_ms", "ORS navigation provider latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 8_000, 15_000], {
  provider: ["openrouteservice"],
  outcome: ["live", "unavailable"],
});
metrics.registerCounter("navigation_route_tool_invocations_total", "navigation.route skill execution outcomes.", {
  outcome: ["live", "unavailable"],
  provider: ["openrouteservice"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved", "policy_denied", "per_run_cap_exceeded"],
  transport_mode: ["walk", "drive", "cycle"],
});

// Global POI & ground mobility — mobility (docs/ground-mobility-implementation.md §7).
metrics.registerCounter("mobility_provider_requests_total", "Amadeus Transfer provider requests by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["amadeus-transfer"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
metrics.registerHistogram("mobility_provider_latency_ms", "Amadeus Transfer provider latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 8_000, 15_000], {
  provider: ["amadeus-transfer"],
  outcome: ["live", "unavailable"],
});
metrics.registerCounter("mobility_search_tool_invocations_total", "mobility.search skill execution outcomes.", {
  outcome: ["live", "unavailable"],
  provider: ["amadeus-transfer"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved", "policy_denied"],
});
metrics.registerCounter("mobility_offer_selected_total", "Server-tracked mobility offer selection events.", {
  service_type: ["taxi", "transfer", "charter", "rental"],
});
metrics.registerCounter("activities_provider_requests_total", "Viator MCP activity provider requests by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["viator_mcp"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
metrics.registerHistogram("activities_provider_latency_ms", "Viator MCP activity provider latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 8_000, 15_000, 30_000], {
  provider: ["viator_mcp"],
  outcome: ["live", "unavailable"],
});
metrics.registerCounter("activities_tool_invocations_total", "Activities tool execution outcomes.", {
  outcome: ["live", "unavailable"],
  provider: ["viator_mcp"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
// Bounded same-thread LLM context builder metrics.  See
// docs/thread-context-memory-implementation.md §8.  No labels carry
// threadId/tripId/runId — those identifiers live in trace/log context,
// never on metrics.  Values are content-free: counts, character totals,
// and bounded enums.
metrics.registerCounter("conversation_context_build_total", "Same-thread LLM context build outcomes.", {
  result: ["success", "empty", "denied", "error"],
});
metrics.registerCounter("conversation_context_messages", "Total messages returned by the same-thread LLM context builder (count, no labels).");
metrics.registerCounter("conversation_context_chars", "Total UTF-16 characters returned by the same-thread LLM context builder (count, no labels).");
metrics.registerCounter("conversation_context_truncated_total", "Same-thread LLM context builder truncations by bounded reason.", {
  reason: ["turn_limit", "char_limit"],
});
metrics.registerHistogram(
  "agent_task_duration_ms",
  "Accepted-to-terminal durable Agent task latency in milliseconds.",
  [100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 300_000],
  {
    operation: ["conversation", "plan", "replan"],
    outcome: ["completed", "failed", "cancelled"],
  },
);

// ─── Team Agent 协作编排 (Phase 6) ─────────────────────────────────────────
//
// Labels are deliberately low-cardinality enums per spec §8. The forbidden-key
// list already excludes user/trip/plan/value/identifiers, so the only way to
// correlate back to a specific decision is via `app.correlation_id` on the
// related HTTP/DB span.

metrics.registerCounter(
  "trip_constraint_mutation_total",
  "Trip constraint proposal/fact mutations by operation, visibility, strength, and outcome.",
  {
    operation: ["propose", "confirm", "dismiss", "upsert", "revoke"],
    visibility: ["team_visible", "orchestrator_confidential", "n_a"],
    strength: ["hard", "soft", "n_a"],
    result: ["success", "replay", "conflict", "catalog_invalid"],
  },
);

metrics.registerCounter(
  "plan_adoption_vote_total",
  "Plan adoption votes by decision and outcome.",
  {
    decision: ["accept", "needs_changes"],
    result: ["cast", "adopted", "blocked", "stale_plan"],
  },
);

metrics.registerCounter(
  "plan_replan_total",
  "Auto REPLAN enqueues by trigger and outcome.",
  {
    trigger: ["trip_constraint_confirmed", "trip_constraint_revoked", "trip_constraint_upsert", "consent", "change_event"],
    result: ["enqueued", "superseded", "missing_snapshot"],
  },
);

export type Metrics = typeof metrics;
