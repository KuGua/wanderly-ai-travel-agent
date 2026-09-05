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

/** One registered series as reported by {@link MetricsRegistry.describe}. */
export interface SeriesDescriptor {
  name: string;
  type: Series["type"];
  help: string;
  allowedLabels: AllowedLabels;
  /** Upper bounds in the series' unit; histograms only. */
  buckets?: readonly number[];
}

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

  /**
   * Read-only view of the registered series and their bounded label schema.
   *
   * The registry is the source of truth for what `/metrics` can ever emit, so
   * `scripts/verify-docs.ts` reads this instead of regex-parsing the module: a
   * renamed metric or a changed allow-list then fails CI rather than silently
   * orphaning a dashboard panel or an alert rule. Sorted by name so generated
   * documentation has a stable diff.
   */
  describe(): SeriesDescriptor[] {
    return [...this.series.entries()]
      .map(([name, series]) => ({
        name,
        type: series.type,
        help: series.help,
        allowedLabels: series.allowedLabels,
        ...(series.type === "histogram" ? { buckets: [...series.buckets] } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
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

// HTTP SLIs must not be inferred from sampled traces. These two series are
// deliberately label-bounded and are emitted by Fastify's response hook.
metrics.registerCounter("http_requests_total", "Completed HTTP requests by method and response status class.", {
  method: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "OTHER"],
  status_class: ["1xx", "2xx", "3xx", "4xx", "5xx"],
});
metrics.registerHistogram(
  "http_request_duration_ms",
  "Completed HTTP request duration in milliseconds by method and response status class.",
  [10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000],
  {
    method: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "OTHER"],
    status_class: ["1xx", "2xx", "3xx", "4xx", "5xx"],
  },
);

metrics.registerCounter("agent_skill_runs_total", "Registry skill invocations by bounded agent, skill and outcome.", {
  agent: ["personal", "shared"],
  skill: ["profile.memory", "profile.change_proposal", "consent.explanation", "thread.recall", "travel.conversation", "trip.constraint.propose", "plan.comparison", "readiness.check", "flight.search", "hotel.search", "accommodation.discover", "activities.search", "places.search", "places.adopt", "navigation.route", "mobility.search", "other"],
  outcome: ["success", "failure", "rejected", "timeout"],
});
metrics.registerHistogram("agent_skill_duration_ms", "Registry skill end-to-end duration by bounded agent, skill and outcome.", [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000], {
  agent: ["personal", "shared"],
  skill: ["profile.memory", "profile.change_proposal", "consent.explanation", "thread.recall", "travel.conversation", "trip.constraint.propose", "plan.comparison", "readiness.check", "flight.search", "hotel.search", "accommodation.discover", "activities.search", "places.search", "places.adopt", "navigation.route", "mobility.search", "other"],
  outcome: ["success", "failure", "rejected", "timeout"],
});
metrics.registerCounter("agent_skill_retries_total", "Registry skill retry attempts by bounded agent and skill.", {
  agent: ["personal", "shared"],
  skill: ["profile.memory", "profile.change_proposal", "consent.explanation", "thread.recall", "travel.conversation", "trip.constraint.propose", "plan.comparison", "readiness.check", "flight.search", "hotel.search", "accommodation.discover", "activities.search", "places.search", "places.adopt", "navigation.route", "mobility.search", "other"],
});
metrics.registerCounter("plan_validation_failures_total", "Plan validation failures by bounded result.", {
  validationResult: ["schema", "authorization", "route", "provenance", "evidence", "unknown"],
});
metrics.registerCounter("booking_gate_denials_total", "Booking gate denials by bounded category.", {
  errorCategory: ["callback_auth", "membership", "quorum", "plan_state", "plan_unavailable", "non_unanimous", "snapshot_stale", "offer_stale", "unknown"],
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
metrics.registerCounter("ui_diagnostic_events_total", "Authenticated, content-free browser diagnostic events.", {
  action: ["frontend.runtime", "profile.save", "trip.activate", "trip.thread_create", "conversation.submit", "agent.run_cancel", "invitation.accept", "invitation.decline", "plan.confirm", "booking.confirm"],
  outcome: ["success", "failure"],
  error_category: ["none", "validation", "network", "http_4xx", "http_5xx", "timeout", "aborted", "invalid_response", "render", "unhandled"],
});

// docs/flight-offer-cue-model-draft.md §10, docs/hotel-offer-cue-model-draft.md §9.
// Low-cardinality labels only: capability, outcome, action, source. Never
// include candidateRef, routeKey/stayKey, tripId/threadId/ownerUserId,
// provider IDs, prices, or message text.
metrics.registerCounter("offer_cue_decision_total", "Offer cue decisions emitted by the resolver.", {
  capability: ["flight", "hotel"],
  outcome: [
    "created", "skipped_policy", "skipped_duplicate", "skipped_freshness",
    "skipped_clarification", "failure", "no_candidates", "needs_clarification",
  ],
});
metrics.registerCounter("offer_cue_action_total", "Offer cue card accept/dismiss outcomes.", {
  capability: ["flight", "hotel"],
  action: ["accept", "dismiss"],
  outcome: [
    "success", "stale_version", "not_found", "forbidden", "trip_state",
    "conflict", "expired", "failure",
  ],
  source: ["card_button", "result_card_button"],
});
metrics.registerCounter("offer_cue_resolution_total", "Offer cue batches final state transitions.", {
  capability: ["flight", "hotel"],
  outcome: ["resolved", "superseded", "expired"],
});
metrics.registerCounter("personal_offer_selection_total", "Personal offer selection write outcomes.", {
  capability: ["flight", "hotel"],
  outcome: ["created", "superseded", "removed"],
});
metrics.registerHistogram(
  "offer_cue_resolver_duration_ms",
  "Wall clock duration of the offer cue LLM resolver.",
  [50, 100, 250, 500, 1_000, 2_000, 5_000, 9_000, 15_000, 30_000],
  {
    capability: ["flight", "hotel"],
    outcome: ["success", "timeout", "parse_error", "upstream_failure", "client_unavailable"],
  },
);

// docs/long-term-memory-implementation.md section 7. Bounded enums only:
// field keys, values, observation dates, trip ids and activation are all
// forbidden as labels — they would be high-cardinality and, worse, would leak
// what the product remembers about a person.
metrics.registerCounter(
  "memory_observation_skipped_total",
  "Confirmed constraints that produced no memory observation, by bounded reason.",
  { reason: ["not_in_catalog", "value_not_an_object", "value_shape_mismatch"] },
);
metrics.registerCounter(
  "conversation_memory_notes_dropped_total",
  "Free-text notes a traveller keeps that did not fit the conversation budget.",
);
metrics.registerCounter("memory_proposals_total", "Behaviour-derived memory proposals by bounded outcome.", {
  outcome: ["created", "aggregated", "duplicate_episode", "in_cooldown", "rejected"],
  source: ["behavior_aggregation"],
});
metrics.registerCounter("memory_fact_mutations_total", "Preference fact mutations by bounded operation.", {
  operation: ["replace", "delete"],
  source: ["profile_form", "proposal_confirmation"],
});
metrics.registerCounter("memory_projection_build_total", "Memory namespace projections built for a snapshot.", {
  result: ["built", "empty", "failed"],
});
metrics.registerCounter("memory_proposal_resolutions_total", "Proposal lifecycle transitions by bounded outcome.", {
  outcome: ["confirmed", "dismissed", "expired", "already_resolved", "not_found"],
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
  "Latency of LLM request attempts in milliseconds, including failures.",
  [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000],
  {
    provider: ["openai", "gemini", "openai-compatible"],
    outcome: ["success", "failure"],
  },
);
metrics.registerCounter(
  "llm_request_errors_total",
  "LLM request attempt outcomes, by provider, error category and retryability.",
  {
    provider: ["openai", "gemini", "openai-compatible"],
    error_category: ["upstream_5xx", "upstream_failure", "network", "timeout", "schema_parse", "tool_protocol", "rate_limited", "unknown"],
    retryable: ["true", "false"],
  },
);
metrics.registerCounter("agent_task_outcomes_total", "Durable Agent task outcomes by bounded operation and result.", {
  operation: ["conversation", "plan", "replan", "research", "personal_research"],
  outcome: ["completed", "completed_with_gaps", "failed", "cancelled", "retrying"],
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
metrics.registerCounter(
  "trip_brief_destination_resolution_total",
  "Draft-brief destination submissions by whether the catalogue could resolve them.",
  { result: ["accepted", "unresolved"] },
);
metrics.registerCounter(
  "trip_brief_proposal_dates_total",
  "Conversation-proposed brief dates by whether the pair held together on the way to the trip.",
  { result: ["ok", "end_before_start", "in_past", "malformed"] },
);
metrics.registerCounter(
  "trip_brief_proposal_destination_resolution_total",
  "Conversation brief proposals accepted or rejected by the city-only destination contract.",
  { result: ["accepted", "rejected"] },
);

// Every value `requireActiveTrip` is called with has to be listed, or the
// rejection it is recording throws instead: `metrics.inc` refuses an
// undeclared label, so a Draft trip answered 500 where it meant to answer
// 409. The `constraint_*` operations were added to the guard without being
// added here, which took `GET /trips/:tripId/plans` down for every Draft.
metrics.registerCounter("draft_command_rejected_total", "Collaboration commands rejected because the Trip is still a Draft.", {
  operation: [
    "invitation", "consent", "planning", "confirmation", "booking", "change_event", "research",
    "constraint_read", "constraint_upsert", "constraint_propose",
    "constraint_confirm", "constraint_dismiss", "constraint_revoke",
  ],
});
metrics.registerCounter("trip_invitation_rejected_total", "Trip invitation attempts rejected because the Trip is archived or cancelled.", {
  reason: ["terminal_trip"],
});
metrics.registerCounter("agent_task_recoveries_total", "Expired Agent task leases and queue entries recovered.", {
  outcome: ["retrying", "failed", "cancelled"],
});
metrics.registerCounter("flight_provider_requests_total", "Flight provider requests by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["amadeus", "flightapi", "serpapi"],
  error_category: ["none", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "no_results", "provider_not_approved", "search_constraints_incomplete", "provider_request_rejected"],
});
metrics.registerCounter("external_provider_http_calls_total", "Outbound provider HTTP calls by bounded provider, operation, and transport result.", {
  provider: ["amadeus", "flightapi", "nuitee_connect", "openrouteservice", "opentripmap", "serpapi", "viator_mcp", "location_reference"],
  operation: ["flight.search", "hotel.search", "accommodation.discover", "place.search", "navigation.route", "mobility.search", "activities.search", "oauth.token", "location.resolve"],
  outcome: ["success", "failure"],
});
metrics.registerHistogram("external_provider_http_latency_ms", "Outbound provider HTTP transport latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 8_000, 15_000, 30_000], {
  provider: ["amadeus", "flightapi", "nuitee_connect", "openrouteservice", "opentripmap", "serpapi", "viator_mcp", "location_reference"],
  operation: ["flight.search", "hotel.search", "accommodation.discover", "place.search", "navigation.route", "mobility.search", "activities.search", "oauth.token", "location.resolve"],
});
metrics.registerHistogram("flight_provider_latency_ms", "Flight provider latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 8_000, 15_000], {
  provider: ["amadeus", "flightapi", "serpapi"],
  outcome: ["live", "unavailable"],
});
metrics.registerCounter("flight_tool_invocations_total", "Flight tool execution outcomes.", {
  outcome: ["live", "unavailable"],
  provider: ["amadeus", "flightapi", "serpapi", "unconfigured"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
metrics.registerCounter("flight_offer_staleness_total", "Selected flight offers rejected by the confirmation/booking freshness guard, by bounded reason.", {
  reason: ["expired", "missing_expiry", "unverifiable_expiry"],
});
// Global POI & ground mobility (docs/ground-mobility-implementation.md §7).
// All label sets are bounded enums; identifiers (trip_id / run_id /
// place_id / route_id) live only in trace/log correlation context.
metrics.registerCounter(
  "hotel_provider_city_mismatch_total",
  "Hotel rates dropped for sitting in a different city from the one searched.",
  { provider: ["nuitee_connect", "serpapi"], outcome: ["partial", "all_elsewhere", "empty"] },
);
metrics.registerCounter(
  "memory_highlight_outcomes_total",
  "What became of a highlight: a catalogue field, the traveller's own words, or a refusal.",
  { outcome: ["field", "note", "too_long", "list_full", "sensitive_field", "empty"] },
);
metrics.registerCounter(
  "free_text_memory_writes_total",
  "Free-text memory writes by outcome (highlight fallback).",
  { result: ["saved", "too_long", "list_full"] },
);
metrics.registerCounter("place_provider_requests_total", "Place provider requests by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["openrouteservice", "opentripmap"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
metrics.registerHistogram("place_provider_latency_ms", "Place provider latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 8_000, 15_000], {
  provider: ["openrouteservice", "opentripmap"],
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

metrics.registerCounter("hotel_provider_requests_total", "Hotel provider requests by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["nuitee_connect", "serpapi_google_hotels", "unconfigured"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
metrics.registerHistogram("hotel_provider_latency_ms", "Hotel provider latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 8_000, 10_000, 15_000, 30_000], {
  provider: ["nuitee_connect", "serpapi_google_hotels", "unconfigured"],
  outcome: ["live", "unavailable"],
});
metrics.registerCounter("accommodation_provider_requests_total", "Accommodation discovery provider requests by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["opentripmap"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
metrics.registerHistogram("accommodation_provider_latency_ms", "Accommodation discovery provider latency in milliseconds.", [100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000], {
  provider: ["opentripmap"],
  outcome: ["live", "unavailable"],
});
metrics.registerCounter("accommodation_tool_invocations_total", "accommodation.discover Tool invocations by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["opentripmap"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
metrics.registerCounter("hotel_tool_invocations_total", "hotel.search Tool invocations by bounded outcome.", {
  outcome: ["live", "unavailable"],
  provider: ["nuitee_connect", "serpapi_google_hotels", "unconfigured"],
  error_category: ["none", "not_configured", "search_constraints_incomplete", "no_results", "rate_limited", "upstream_timeout", "upstream_failure", "invalid_provider_response", "provider_not_approved"],
});
metrics.registerCounter("provider_search_cache_total", "Provider search read-through cache outcomes.", {
  category: ["hotel", "activity", "accommodation"],
  outcome: ["hit_live", "hit_unavailable", "miss", "wait_timeout"],
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
metrics.registerCounter("conversation_memory_context_total", "Cross-thread long-term memory context build outcomes.", {
  result: ["success", "empty"],
});
metrics.registerCounter("conversation_memory_context_facts", "Total long-term memory facts passed to a conversation turn (count, no labels).");
metrics.registerHistogram(
  "agent_task_duration_ms",
  "Accepted-to-terminal durable Agent task latency in milliseconds.",
  [100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 300_000],
  {
    operation: ["conversation", "plan", "replan", "research", "personal_research"],
    outcome: ["completed", "completed_with_gaps", "failed", "cancelled"],
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
    operation: ["propose", "confirm", "dismiss", "upsert", "revoke", "handoff_confirm"],
    visibility: ["team_visible", "orchestrator_confidential", "mixed", "n_a"],
    strength: ["hard", "soft", "mixed", "n_a"],
    result: ["success", "replay", "conflict", "catalog_invalid"],
  },
);

metrics.registerCounter(
  "conversation_handoff_candidate_batch_total",
  "Member conversation candidate batches produced by Personal Agent (Phase 6 handoff).",
  {
    result: ["extracted", "catalog_invalid", "extraction_failed", "empty"],
  },
);

metrics.registerCounter(
  "conversation_handoff_confirm_total",
  "Member conversation handoff confirmations by accepted durable task operation and outcome.",
  {
    operation: ["plan", "replan"],
    result: ["success", "rejected", "stale", "conflict"],
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

// Private thread title lifecycle (docs/thread-title-lifecycle-implementation.md §11.1).
// Labels are bounded enums only — thread/trip/user IDs and the title text
// itself are forbidden as metric labels and live in trace/log context.
metrics.registerCounter(
  "thread_title_writes_total",
  "Private thread title writes by bounded source and result.",
  {
    source: ["deterministic", "llm", "manual"],
    result: ["applied", "rejected", "unavailable", "no_material", "manual_locked"],
  },
);

// Trip title destination-label lifecycle (docs/trip-title-destination-label-implementation.md §10.1).
// Same privacy discipline: the label text, trip id and user id are forbidden
// as metric labels and live in trace/log context only.
metrics.registerCounter(
  "trip_title_writes_total",
  "Trip title destination-label writes by bounded source and result.",
  {
    source: ["reference", "llm", "manual"],
    result: [
      "applied", "rejected", "unavailable", "no_material",
      "manual_locked", "not_draft", "superseded", "rate_limited",
    ],
  },
);

// Phase 3 — Personal Trip Orchestrator.
metrics.registerCounter(
  "research_stage_total",
  "Personal Trip Orchestrator SSE stage transitions by bounded outcome.",
  {
    stage: [
      "snapshot_created",
      "researching",
      "validating",
      "persisting",
      "completed",
      "completed_with_gaps",
      "failed",
      "stale",
    ],
    outcome: ["success", "failure"],
  },
);

// Personal Research Intent Routing — Phase 0/1.
// Labels carry only bounded enum values. The question text, place names,
// and identifiers live in log/trace context (NOT as metric labels —
// `FORBIDDEN_LABEL_KEYS` blocks them upstream).
metrics.registerCounter(
  "personal_research_intent_total",
  "Personal research intent classifier dispositions.",
  {
    capability: [
      "flight", "accommodation", "hotel", "activities",
      "places", "navigation", "mobility", "readiness",
    ],
    disposition: ["proposed", "conversation", "refusal"],
  },
);
metrics.registerCounter(
  "personal_research_readiness_total",
  "Personal research readiness evaluation outcomes.",
  {
    capability: [
      "flight", "accommodation", "hotel", "activities",
      "places", "navigation", "mobility", "readiness",
    ],
    outcome: ["ready", "needs_setup", "needs_place_selection"],
  },
);
metrics.registerCounter(
  "personal_research_intent_confirmation_total",
  "Personal research intent lifecycle transitions.",
  {
    outcome: ["confirmed", "dismissed", "superseded", "lease_lost"],
  },
);
metrics.registerCounter(
  "personal_research_setup_session_total",
  "Personal research setup session lifecycle outcomes (per-intent).",
  {
    outcome: ["opened", "updated", "confirmed", "cancelled", "expired", "open_failed"],
  },
);
metrics.registerCounter(
  "personal_research_setup_followup_total",
  "Conversational setup follow-up generator outcomes.",
  {
    outcome: ["model", "fallback"],
    reason: ["model", "empty", "no_gateway", "schema", "invalid_code", "pii", "length", "model_error"],
  },
);
metrics.registerCounter(
  "personal_research_setup_followup_questions_total",
  "Quick-orchestration multi-slot follow-up: per-question outcome.",
  {
    outcome: ["model", "fallback"],
  },
);
metrics.registerCounter(
  "personal_research_proactive_intro_total",
  "Quick-orchestration proactive intro: enqueue + render outcomes.",
  {
    outcome: ["rendered", "skipped_team", "failure", "enqueued"],
  },
);
metrics.registerCounter(
  "research_auto_accept_total",
  "Quick-orchestration solo auto-accept outcomes (PROPOSE_PLAN → ACTIVE inline).",
  {
    outcome: ["adopted", "stale_plan", "already_adopted", "not_solo", "error"],
  },
);
metrics.registerCounter(
  "pin_write_total",
  "Server-managed pinned-session writes.",
  {
    path: ["orchestrator", "confirm"],
    outcome: ["success", "skipped", "failure"],
  },
);

metrics.registerCounter(
  "solo_plan_adoption_total",
  "Solo plan adoption outcomes — owner ACCEPT flips PROPOSED to ACTIVE in one round trip.",
  {
    outcome: ["adopted", "stale_plan", "not_solo", "forbidden", "plan_not_proposed", "error"],
  },
);

metrics.registerCounter(
  "plan_replan_total",
  "Auto REPLAN enqueues by trigger and outcome.",
  {
    trigger: ["trip_constraint_confirmed", "trip_constraint_revoked", "trip_constraint_upsert", "consent", "change_event", "conversation_handoff"],
    result: ["enqueued", "superseded", "missing_snapshot"],
  },
);

export type Metrics = typeof metrics;
