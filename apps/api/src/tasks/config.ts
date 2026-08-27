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
} as const;

if (resolvedAgentTaskConfig.leaseRenewSeconds >= resolvedAgentTaskConfig.leaseSeconds) {
  throw new Error("AGENT_TASK_LEASE_RENEW_SECONDS must be less than AGENT_TASK_LEASE_SECONDS");
}

export const agentTaskConfig = resolvedAgentTaskConfig;