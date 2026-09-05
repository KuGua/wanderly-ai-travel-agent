function positiveInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + " must be an integer between " + minimum + " and " + maximum);
  }
  return value;
}

const resolvedAgentTaskConfig = {
  leaseSeconds: positiveInteger("AGENT_TASK_LEASE_SECONDS", 30, 10, 300),
  leaseRenewSeconds: positiveInteger("AGENT_TASK_LEASE_RENEW_SECONDS", 10, 2, 120),
  queueTtlSeconds: positiveInteger("AGENT_TASK_QUEUE_TTL_SECONDS", 300, 30, 3600),
  pollIntervalMs: positiveInteger("AGENT_WORKER_POLL_INTERVAL_MS", 500, 100, 10_000),
  workerConcurrency: positiveInteger("AGENT_WORKER_CONCURRENCY", 1, 1, 8),
  streamKeepAliveMs: positiveInteger("AGENT_STREAM_KEEP_ALIVE_MS", 15_000, 5_000, 60_000),
  maxDeltaBytes: positiveInteger("AGENT_STREAM_MAX_DELTA_BYTES", 1024, 64, 2048),
  // Bounded same-thread context for the Personal Agent. See
  // docs/thread-context-memory-implementation.md §3.2. The model receives
  // raw `chat_messages.body` for the same `threadId`+`ownerUserId` only,
  // capped at MAX_TURNS complete USER→ASSISTANT pairs and MAX_CHARS UTF-16
  // characters, with an upper sequence boundary pinned at task acceptance.
  conversationContextMaxTurns: positiveInteger("CONVERSATION_CONTEXT_MAX_TURNS", 8, 1, 12),
  conversationContextMaxChars: positiveInteger("CONVERSATION_CONTEXT_MAX_CHARS", 12_000, 1, 20_000),
  // Aggregate wall clock one conversation turn may spend inside tool dispatch,
  // metered by `createTurnDeadline`'s paused windows. Exhausting it aborts
  // nothing — `dispatchTool` answers a structured UNAVAILABLE so the model
  // still replies. See §5.1 of
  // docs/planner-resilience-and-reflection-implementation.md.
  conversationToolBudgetMs: positiveInteger("CONVERSATION_TOOL_BUDGET_MS", 20_000, 1_000, 120_000),
  // Wall clock one conversation turn may spend *inside the model*, metered by
  // `createTurnDeadline`. Tool dispatch does not count against it — those
  // windows are paused and charged to `conversationToolBudgetMs` above.
  //
  // Was hard-coded at 15s on `travelConversationSkill.timeoutMs`. Two
  // consecutive turns measured on 2026-09-05 each spent 15.0s of pure model
  // time: the first finished on the line, the second was aborted by this
  // deadline and surfaced to the traveller as "I can't reach the conversation
  // model right now". At the ceiling the failure is systematic, not flaky.
  //
  // 30s doubles the headroom while keeping the worst case well under
  // `CONVERSATION_TURN_HARD_CAP_MS` (120s) even with the tool budget spent.
  // If this starts being exhausted too, the answer is to narrow the context
  // (`conversationContextMaxTurns` / `MaxChars`), not to keep raising it.
  conversationModelBudgetMs: positiveInteger("CONVERSATION_MODEL_BUDGET_MS", 30_000, 5_000, 90_000),
} as const;

if (resolvedAgentTaskConfig.leaseRenewSeconds >= resolvedAgentTaskConfig.leaseSeconds) {
  throw new Error("AGENT_TASK_LEASE_RENEW_SECONDS must be less than AGENT_TASK_LEASE_SECONDS");
}

export const agentTaskConfig = resolvedAgentTaskConfig;