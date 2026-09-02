import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { auditEvents, chatThreads, idempotencyRecords, users } from "../src/db/schema.js";
import { AgentStreamRelay } from "../src/tasks/agent-stream-relay.js";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";
import { provisionTripAndMember } from "./helpers/trip.js";

// The SSE handler hijacks the reply, which bypasses Fastify's onSend chain.
// `app.inject` cannot observe what actually reaches the socket in that case, so
// these assertions run against a real loopback listener.
let app: FastifyInstance;
let baseUrl: string;
let tripId: string;

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken, agentStreamRelay: new AgentStreamRelay() });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test listener");
  baseUrl = `http://127.0.0.1:${address.port}`;
  // Per docs/trip-scoped-private-threads-implementation.md §1.1 every
  // chat thread must belong to a Trip and the creator must be an active
  // member.  Provision a Trip for the alice test user once per suite.
  // Provision alice rather than assume her: nothing seeds this user, so the
  // suite was relying on trip-default-thread.test.ts having created her — a
  // file that sorts *after* this one. On a database that already carried her
  // from an earlier run it passed; on a fresh one, as in CI, it failed here
  // before the first assertion.
  const [inserted] = await db.insert(users)
    .values({ externalId: "alice", displayName: "Alice" })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  const alice = inserted
    ?? (await db.select().from(users).where(eq(users.externalId, "alice")).limit(1))[0]!;
  const provisioned = await provisionTripAndMember({ ownerUserId: alice.id });
  tripId = provisioned.tripId;
});

afterAll(async () => {
  await app.close();
});

describe("authenticated agent run stream response headers", () => {
  it("keeps the negotiated cross-origin and correlation headers on the hijacked stream", async () => {
    const origin = "http://localhost:3001";
    const requestId = randomUUID();
    const threadId = await createThread(`Stream headers ${randomUUID()}`);
    const controller = new AbortController();
    const correlationIds: string[] = [];

    try {
      const accepted = await fetch(`${baseUrl}/api/v1/threads/${threadId}/turns`, {
        method: "POST",
        headers: { ...authHeaders("alice"), "content-type": "application/json", origin },
        body: JSON.stringify({ requestId, question: "Tell me about Kyoto" }),
      });
      expect(accepted.status).toBe(202);
      const acceptedCorrelation = accepted.headers.get("x-correlation-id");
      if (acceptedCorrelation) correlationIds.push(acceptedCorrelation);
      const { runId } = await accepted.json() as { runId: string };

      const stream = await fetch(`${baseUrl}/api/v1/agent-runs/${runId}/events`, {
        headers: { ...authHeaders("alice"), accept: "text/event-stream", origin },
        signal: controller.signal,
      });

      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      // Without these a browser rejects the cross-origin stream and silently
      // degrades to polling the durable run instead of streaming deltas.
      expect(stream.headers.get("access-control-allow-origin")).toBe(origin);
      expect(stream.headers.get("x-correlation-id")).toBeTruthy();
      const streamCorrelation = stream.headers.get("x-correlation-id");
      if (streamCorrelation) correlationIds.push(streamCorrelation);
    } finally {
      controller.abort();
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(idempotencyRecords)
        .where(eq(idempotencyRecords.idempotencyKey, `chat_turn:${threadId}:${requestId}`));
      if (correlationIds.length > 0) {
        await db.delete(auditEvents).where(inArray(auditEvents.correlationId, correlationIds));
      }
    }
  });
});

async function createThread(title: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { ...authHeaders("alice"), "content-type": "application/json", origin: "http://localhost:3001" },
    body: JSON.stringify({ title, tripId }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}
