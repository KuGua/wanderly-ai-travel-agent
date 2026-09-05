import { agentStreamEventSchema, type AgentStreamEvent } from "../types/schemas.js";
import { db, rawDb } from "../db/database.js";
import { agentStreamEvents } from "../db/schema.js";
import { logger } from "../utils/logger.js";
import { agentTaskConfig } from "./config.js";

export const AGENT_STREAM_CHANNEL = "wanderly_agent_stream";
const POSTGRES_NOTIFY_MAX_BYTES = 7_500;

export async function publishAgentStreamEvent(event: AgentStreamEvent): Promise<void> {
  const parsed = agentStreamEventSchema.parse(event);
  if (parsed.event === "message.delta" && Buffer.byteLength(parsed.delta, "utf8") > agentTaskConfig.maxDeltaBytes) {
    throw new Error("Approved stream delta exceeds configured byte limit");
  }
  // Persist before notifying. A subscriber that connects after a fast worker
  // finishes can replay these private frames instead of falling back to a
  // whole persisted assistant message. Journal failure remains fail-open for
  // the business task, exactly like a relay outage.
  let published = parsed;
  try {
    const [stored] = await db.insert(agentStreamEvents).values({
      runId: parsed.runId,
      event: parsed,
    }).returning({ id: agentStreamEvents.id });
    if (stored) published = agentStreamEventSchema.parse({ ...parsed, streamEventId: String(stored.id) });
  } catch (error) {
    logger.warn({
      component: "agent-stream-publisher",
      event: parsed.event,
      runId: parsed.runId,
      errorClass: (error as Error).name,
    }, "Agent stream journal failed; delivering live-only event");
  }
  const payload = JSON.stringify(published);
  if (Buffer.byteLength(payload, "utf8") > POSTGRES_NOTIFY_MAX_BYTES) {
    throw new Error("Agent stream event exceeds PostgreSQL notification limit");
  }
  try {
    await rawDb.notify(AGENT_STREAM_CHANNEL, payload);
  } catch (error) {
    // Streaming is an observation channel, not the source of truth. A relay
    // outage must never roll back or fail an already accepted durable task.
    logger.warn({
      component: "agent-stream-publisher",
      event: parsed.event,
      runId: parsed.runId,
      errorClass: (error as Error).name,
    }, "Agent stream notification failed; clients can recover from run state");
  }
}
