import type { Sql } from "postgres";

import { createDedicatedDatabaseClient } from "../db/database.js";
import { agentStreamEventSchema, type AgentStreamEvent } from "../types/schemas.js";
import { AGENT_STREAM_CHANNEL } from "./task-stream-publisher.js";

type Subscriber = (event: AgentStreamEvent) => void;

export class AgentStreamRelay {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private listener: Sql | null = null;
  private unlisten: (() => Promise<void>) | null = null;

  async start(): Promise<void> {
    if (this.listener) return;
    const listener = createDedicatedDatabaseClient();
    const subscription = await listener.listen(AGENT_STREAM_CHANNEL, (payload) => {
      this.dispatchPayload(payload);
    });
    this.listener = listener;
    this.unlisten = subscription.unlisten;
  }

  subscribe(runId: string, subscriber: Subscriber): () => void {
    const current = this.subscribers.get(runId) ?? new Set<Subscriber>();
    current.add(subscriber);
    this.subscribers.set(runId, current);
    return () => {
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(runId);
    };
  }

  dispatch(event: AgentStreamEvent): void {
    const parsed = agentStreamEventSchema.parse(event);
    this.subscribers.get(parsed.runId)?.forEach((subscriber) => subscriber(parsed));
  }

  async stop(): Promise<void> {
    const unlisten = this.unlisten;
    const listener = this.listener;
    this.unlisten = null;
    this.listener = null;
    this.subscribers.clear();
    if (unlisten) await unlisten();
    if (listener) await listener.end({ timeout: 5 });
  }

  private dispatchPayload(payload: string): void {
    let candidate: unknown;
    try {
      candidate = JSON.parse(payload);
    } catch {
      return;
    }
    const parsed = agentStreamEventSchema.safeParse(candidate);
    if (parsed.success) this.dispatch(parsed.data);
  }
}
