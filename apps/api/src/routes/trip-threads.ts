import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { db } from "../db/database.js";
import { chatMessages, chatThreads, tripMembers } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { recordAudit } from "../services/audit-service.js";
import {
  buildIndexedThreadTitle,
  type ThreadTitleLocale,
} from "../services/thread-title-service.js";
import { postprocessThreadTitle } from "../services/thread-title-suggest-postprocess.js";
import { getOrCreateDefaultThread } from "../services/trip-invitation-service.js";
import { createRequestContext } from "../utils/context.js";
import { metrics } from "../observability/metrics.js";
import { invokeSkill } from "../agents/skill-registry.js";
import { SkillError } from "../agents/errors.js";
import { DefaultPolicyGate } from "../agents/policy-gate.js";
import { ThreadTitleSuggestRateLimiter } from "./thread-title-suggest-rate-limit.js";
import {
  createTripThreadSchema,
  renameThreadRequestSchema,
  threadSummarySchema,
  threadsListResponseSchema,
  toJsonSchema,
  type ThreadSummary,
} from "../types/schemas.js";

const suggestRateLimiter = new ThreadTitleSuggestRateLimiter();

const suggestThreadTitleRequestSchema = z.object({
  requestId: z.string().uuid(),
  locale: z.enum(["en", "zh"]),
  overwriteManual: z.boolean().optional(),
}).strict();

const suggestThreadTitleResponseSchema = z.object({
  thread: threadSummarySchema,
  applied: z.boolean(),
  reason: z.enum(["MANUAL_LOCKED", "NO_MATERIAL", "REJECTED", "UNAVAILABLE"]).optional(),
}).strict();

const MAX_INPUT_MESSAGES = 3;
const MAX_MESSAGE_TEXT = 512;

async function requireTripMember(tripId: string, userId: string): Promise<void> {
  const rows = await db.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, userId)))
    .limit(1);
  if (rows.length === 0) {
    // Never 404 in place of 403: the caller might be probing the trip
    // space, and a hard 403 keeps the contract consistent.
    throw new ApiError(403, "Forbidden", "Not a member of this trip");
  }
}

function toThreadSummary(row: typeof chatThreads.$inferSelect): ThreadSummary {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    tripId: row.tripId,
    scope: row.scope,
    isDefault: row.isDefault,
    title: row.title,
    titleSource: row.titleSource,
    titleLocale: row.titleLocale,
    titleUpdatedAt: row.titleUpdatedAt ? row.titleUpdatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

export async function tripThreadRoutes(app: FastifyInstance) {
  // List the caller's own active threads in this Trip.  Trip-mates'
  // threads are intentionally not visible: per
  // docs/trip-scoped-private-threads-implementation.md §1.1.4, threads
  // are owner-only even within the same Trip.
  app.get("/trips/:tripId/threads", async (request) => {
    const { tripId } = request.params as { tripId: string };
    await requireTripMember(tripId, request.user.id);

    const rows = await db.select()
      .from(chatThreads)
      .where(and(
        eq(chatThreads.tripId, tripId),
        eq(chatThreads.ownerUserId, request.user.id),
        sql`${chatThreads.archivedAt} IS NULL`,
      ))
      .orderBy(desc(chatThreads.isDefault), desc(chatThreads.createdAt), asc(chatThreads.id));

    return threadsListResponseSchema.parse({
      threads: rows.map(toThreadSummary),
    });
  });

  // Create an additional non-default private thread for the caller.
  // Per docs/thread-title-lifecycle-implementation.md §7.3:
  //   - `title` provided → MANUAL, titleLocale=NULL (preserves legacy direct
  //     callers' semantics).
  //   - `title` omitted → server-side index inside the same transaction, so
  //     two concurrent creates cannot collide on the same "新对话 N".
  app.post("/trips/:tripId/threads", async (request, reply) => {
    const { tripId } = request.params as { tripId: string };
    await requireTripMember(tripId, request.user.id);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const body = createTripThreadSchema.parse(request.body);
    const locale: ThreadTitleLocale = body.locale ?? "en";
    const now = new Date();

    const [thread] = await db.transaction(async (tx) => {
      let titleToWrite: string;
      let titleSource: "AUTO" | "MANUAL";
      let titleLocale: ThreadTitleLocale | null;
      if (body.title) {
        titleToWrite = body.title;
        titleSource = "MANUAL";
        titleLocale = null;
      } else {
        // Count active (non-archived) threads for this (owner, trip) inside
        // the same transaction. The default isolation level on Postgres
        // makes the count + insert atomic; concurrent creates therefore
        // observe different `n` values and produce distinct indexes.
        const [row] = await tx.select({ n: count() }).from(chatThreads)
          .where(and(
            eq(chatThreads.tripId, tripId),
            eq(chatThreads.ownerUserId, request.user.id),
            sql`${chatThreads.archivedAt} IS NULL`,
          ));
        const nextIndex = (row?.n ?? 0) + 1;
        titleToWrite = buildIndexedThreadTitle(nextIndex, locale);
        titleSource = "AUTO";
        titleLocale = locale;
      }

      const [inserted] = await tx.insert(chatThreads).values({
        ownerUserId: request.user.id,
        tripId,
        scope: "TRIP",
        isDefault: false,
        title: titleToWrite,
        titleSource,
        titleLocale,
        titleUpdatedAt: now,
      }).returning();

      await recordAudit({
        ctx,
        action: "CHAT_THREAD_CREATE",
        actorUserId: request.user.id,
        tripId,
        summary: {
          threadId: inserted.id,
          isDefault: false,
        },
        tx,
      });
      return [inserted];
    });

    metrics.inc("thread_title_writes_total", {
      source: "deterministic",
      result: "applied",
    });

    return reply.code(201).send(threadSummarySchema.parse(toThreadSummary(thread)));
  });

  // Idempotent get-or-create the caller's default scratchpad.  After
  // invitation acceptance this row already exists; the route keeps
  // the recovery semantics so that a missing default row (e.g. legacy
  // pre-onboarding data, network retry) does not strand the UI.
  app.post("/trips/:tripId/threads/default", async (request, reply) => {
    const { tripId } = request.params as { tripId: string };
    await requireTripMember(tripId, request.user.id);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );

    const result = await db.transaction(async (tx) => {
      // The default-thread recovery path runs in English because the spec
      // does not extend it with a locale field. The vast majority of
      // recovers are no-ops; only legacy or pre-onboarding rows actually
      // need a new default thread, and those predate the locale contract.
      const threadId = await getOrCreateDefaultThread(tx, {
        tripId,
        ownerUserId: request.user.id,
        locale: "en",
      });
      const [row] = await tx.select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);
      if (!row) {
        throw new ApiError(500, "Internal Server Error", "Default thread missing after provision");
      }
      await recordAudit({
        ctx,
        action: "TRIP_DEFAULT_THREAD_PROVISION",
        actorUserId: request.user.id,
        tripId,
        summary: { threadId, idempotent: true },
        tx,
      });
      return row;
    });

    return reply.code(200).send(threadSummarySchema.parse(toThreadSummary(result)));
  });

  // Owner-only manual rename. Mirrors the trip-title PATCH shape:
  // FOR UPDATE row lock, creator/owner check, write titleSource='MANUAL'
  // and titleLocale=NULL atomically, audit, response is the updated
  // ThreadSummary. An unknown or wrong-trip thread id is 404 and a thread
  // owned by someone else is 403 — the same two-code split the existing
  // `requireOwnedTripThreadRead` uses, so 404 keeps its meaning. See
  // docs/thread-title-lifecycle-implementation.md §13.
  app.patch("/trips/:tripId/threads/:threadId/title", {
    schema: {
      description: "Set an owner-managed private thread title. MANUAL; never reads chat history and never calls an LLM.",
      tags: ["trip-threads"],
      params: toJsonSchema(z.object({
        tripId: z.string().uuid(),
        threadId: z.string().uuid(),
      }).strict()),
      body: toJsonSchema(renameThreadRequestSchema),
      response: {
        200: toJsonSchema(threadSummarySchema),
        403: toJsonSchema(z.object({
          statusCode: z.literal(403),
          error: z.string(),
          message: z.string(),
          correlationId: z.string().uuid(),
        }).strict()),
        404: toJsonSchema(z.object({
          statusCode: z.literal(404),
          error: z.string(),
          message: z.string(),
          correlationId: z.string().uuid(),
        }).strict()),
      },
    },
  }, async (request, reply) => {
    const { tripId, threadId } = z.object({
      tripId: z.string().uuid(),
      threadId: z.string().uuid(),
    }).strict().parse(request.params);
    const body = renameThreadRequestSchema.parse(request.body);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );

    const updated = await db.transaction(async (tx) => {
      const [thread] = await tx.select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .for("update")
        .limit(1);
      // Absent or bound to a different trip is 404; a thread that exists here
      // but belongs to someone else is 403 below. Thread ids are UUIDs, so
      // the two codes stay distinguishable rather than collapsing 404 into
      // 403 and losing the "no such thread" signal.
      if (!thread || thread.tripId !== tripId) {
        throw new ApiError(404, "Not Found", "Thread not found");
      }
      // Membership is the same gate trip-title uses; without it a non-member
      // could probe the endpoint and observe timing differences.
      await requireTripMember(tripId, request.user.id);
      if (thread.ownerUserId !== request.user.id) {
        throw new ApiError(403, "Forbidden", "Only the thread owner may rename it");
      }

      const now = new Date();
      const [renamed] = await tx.update(chatThreads).set({
        title: body.title,
        titleSource: "MANUAL",
        titleLocale: null,
        titleUpdatedAt: now,
      }).where(eq(chatThreads.id, threadId)).returning();
      if (!renamed) {
        throw new ApiError(500, "Internal Server Error", "Thread update returned no row");
      }
      await recordAudit({
        ctx,
        action: "CHAT_THREAD_TITLE_UPDATE",
        actorUserId: request.user.id,
        tripId,
        summary: { threadId, source: "manual" },
        tx,
      });
      metrics.inc("thread_title_writes_total", {
        source: "manual",
        result: "applied",
      });
      return renamed;
    });

    return reply.code(200).send(threadSummarySchema.parse(toThreadSummary(updated)));
  });

  // Owner-only, rate-limited, fail-closed AI title suggest
  // (docs/thread-title-lifecycle-implementation.md §6.2 / §7.2). Every
  // business-failure path returns 200 with `applied: false, reason`, so the
  // UI can show a recoverable message without rolling the title back.
  app.post("/trips/:tripId/threads/:threadId/title/suggest", {
    schema: {
      description: "Owner-triggered AI title suggestion for a private thread. Manual-locked titles require `overwriteManual: true`.",
      tags: ["trip-threads"],
      params: toJsonSchema(z.object({
        tripId: z.string().uuid(),
        threadId: z.string().uuid(),
      }).strict()),
      body: toJsonSchema(suggestThreadTitleRequestSchema),
      response: {
        200: toJsonSchema(suggestThreadTitleResponseSchema),
        403: toJsonSchema(z.object({
          statusCode: z.literal(403),
          error: z.string(),
          message: z.string(),
          correlationId: z.string().uuid(),
        }).strict()),
        404: toJsonSchema(z.object({
          statusCode: z.literal(404),
          error: z.string(),
          message: z.string(),
          correlationId: z.string().uuid(),
        }).strict()),
        429: toJsonSchema(z.object({
          statusCode: z.literal(429),
          error: z.string(),
          message: z.string(),
          correlationId: z.string().uuid(),
        }).strict()),
      },
    },
  }, async (request, reply) => {
    if (!suggestRateLimiter.allow(request.user.id)) {
      return reply.code(429).send({ statusCode: 429, error: "Too Many Requests", message: "thread.title.suggest rate limit exceeded", correlationId: request.correlationId });
    }
    const { tripId, threadId } = z.object({
      tripId: z.string().uuid(),
      threadId: z.string().uuid(),
    }).strict().parse(request.params);
    const body = suggestThreadTitleRequestSchema.parse(request.body);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );

    const rows = await db.select()
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1);
    const thread = rows[0];
    if (!thread || thread.tripId !== tripId) {
      return reply.code(404).send({ statusCode: 404, error: "Not Found", message: "Thread not found", correlationId: request.correlationId });
    }
    await requireTripMember(tripId, request.user.id);
    if (thread.ownerUserId !== request.user.id) {
      return reply.code(403).send({ statusCode: 403, error: "Forbidden", message: "Only the thread owner may suggest a title", correlationId: request.correlationId });
    }

    // 1. MANUAL lock — without explicit overwrite, refuse without calling
    //    the gateway.
    if (thread.titleSource === "MANUAL" && !body.overwriteManual) {
      metrics.inc("thread_title_writes_total", { source: "llm", result: "manual_locked" });
      return reply.code(200).send(suggestThreadTitleResponseSchema.parse({
        thread: toThreadSummary(thread),
        applied: false,
        reason: "MANUAL_LOCKED",
      }));
    }

    // 2. Pull at most the earliest 3 USER messages for this thread (the
    //    skill's input contract caps at 3 and at 512 chars each; we do both
    //    server-side so the gateway never sees over-cap input).
    const userMessages = await db.select({ body: chatMessages.body, createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.role, "USER"),
      ))
      .orderBy(asc(chatMessages.createdAt))
      .limit(MAX_INPUT_MESSAGES);
    if (userMessages.length === 0) {
      metrics.inc("thread_title_writes_total", { source: "llm", result: "no_material" });
      return reply.code(200).send(suggestThreadTitleResponseSchema.parse({
        thread: toThreadSummary(thread),
        applied: false,
        reason: "NO_MATERIAL",
      }));
    }
    const truncated = userMessages.map((m) => ({ text: m.body.slice(0, MAX_MESSAGE_TEXT) }));

    // 3. Call the skill. All upstream errors map to UNAVAILABLE; the route
    //    never throws to the framework on business failure.
    let raw: { title: string };
    try {
      const out = await invokeSkill("thread.title.suggest", { ctx, policyGate: new DefaultPolicyGate("personal") }, {
        threadId,
        locale: body.locale,
        messages: truncated,
      });
      raw = out as { title: string };
    } catch (err) {
      const code = err instanceof SkillError ? err.code : "UPSTREAM_FAILURE";
      metrics.inc("thread_title_writes_total", { source: "llm", result: "unavailable" });
      void code; // codes are surfaced via audit telemetry, not the user response
      return reply.code(200).send(suggestThreadTitleResponseSchema.parse({
        thread: toThreadSummary(thread),
        applied: false,
        reason: "UNAVAILABLE",
      }));
    }

    // 4. Server-side postprocess. Any rule rejection leaves the row alone.
    const cleaned = postprocessThreadTitle(raw.title, truncated);
    if (!cleaned.ok) {
      metrics.inc("thread_title_writes_total", { source: "llm", result: "rejected" });
      return reply.code(200).send(suggestThreadTitleResponseSchema.parse({
        thread: toThreadSummary(thread),
        applied: false,
        reason: "REJECTED",
      }));
    }

    // 5. Persist in a single transaction with audit + metric.
    const updated = await db.transaction(async (tx) => {
      const [renamed] = await tx.update(chatThreads).set({
        title: cleaned.title,
        titleSource: "AUTO",
        titleLocale: body.locale,
        titleUpdatedAt: new Date(),
      }).where(eq(chatThreads.id, threadId)).returning();
      if (!renamed) {
        throw new ApiError(500, "Internal Server Error", "Thread update returned no row");
      }
      await recordAudit({
        ctx,
        action: "CHAT_THREAD_TITLE_UPDATE",
        actorUserId: request.user.id,
        tripId,
        summary: { threadId, source: "llm" },
        tx,
      });
      return renamed;
    });

    metrics.inc("thread_title_writes_total", { source: "llm", result: "applied" });
    return reply.code(200).send(suggestThreadTitleResponseSchema.parse({
      thread: toThreadSummary(updated),
      applied: true,
    }));
  });
}

// Re-export to silence unused import warnings when schemas are later
// inlined or refactored.  (Currently `toJsonSchema` is exported but
// unused at this layer.)
export { toJsonSchema };
