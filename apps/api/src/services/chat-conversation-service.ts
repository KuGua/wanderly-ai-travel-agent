import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { DefaultPolicyGate } from "../agents/policy-gate.js";
import { invokeSkill } from "../agents/skill-registry.js";
import { db } from "../db/database.js";
import { chatMessages, chatThreads, idempotencyRecords } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { resolveConversationPlace } from "../policy/conversation-safety.js";
import {
  threadRecallSkill,
  type ThreadRecallOutput,
} from "../skills/personal/thread-recall-skill.js";
import {
  travelConversationSkill,
  type TravelConversationOutput,
} from "../skills/personal/travel-conversation-skill.js";
import {
  conversationTurnResponseSchema,
  ownerConversationResponseSchema,
  type ConversationTurnRequest,
  type ConversationTurnResponse,
} from "../types/schemas.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";
import { checkIdempotency, claimIdempotency } from "./idempotency-service.js";

const storedTurnResultSchema = z.object({
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  responseMode: z.enum(["MODEL", "DEMO_FALLBACK"]),
}).strict();

type ChatThreadRow = typeof chatThreads.$inferSelect;

export async function submitConversationTurn(params: {
  ctx: RequestContext;
  threadId: string;
  ownerUserId: string;
  input: ConversationTurnRequest;
}): Promise<ConversationTurnResponse> {
  await requireThreadOwner(params.threadId, params.ownerUserId);

  const idempotencyKey = turnIdempotencyKey(params.threadId, params.input.requestId);
  const existing = await loadStoredTurn(idempotencyKey, params.threadId);
  if (existing) return existing;

  const recall = await invokeSkill<unknown, ThreadRecallOutput>(threadRecallSkill.name, {
    ctx: params.ctx,
    policyGate: new DefaultPolicyGate("personal"),
  }, {
    threadId: params.threadId,
    limit: 20,
  }, {
    expectedVersion: threadRecallSkill.version,
  });

  const history = recall.messages
    .filter(message =>
      (message.role === "USER" || message.role === "ASSISTANT")
      && message.contentRedacted.trim().length > 0
    )
    .map(message => ({
      role: message.role as "USER" | "ASSISTANT",
      content: message.contentRedacted.trim().slice(0, 1000),
    }));

  const reply = await invokeSkill<unknown, TravelConversationOutput>(travelConversationSkill.name, {
    ctx: params.ctx,
    policyGate: new DefaultPolicyGate("personal"),
  }, {
    question: params.input.question,
    place: resolveConversationPlace(params.input.place),
    history,
  }, {
    expectedVersion: travelConversationSkill.version,
  });

  const persisted = await db.transaction(async tx => {
    const claimed = await claimIdempotency(tx, {
      key: idempotencyKey,
      entityType: "chat_turn",
    });
    if (!claimed) return null;

    const [userMessage] = await tx.insert(chatMessages).values({
      threadId: params.threadId,
      senderUserId: params.ownerUserId,
      role: "USER",
      body: params.input.question,
      markedSharedByOwner: false,
      redactedSummary: null,
    }).returning();

    const [assistantMessage] = await tx.insert(chatMessages).values({
      threadId: params.threadId,
      senderUserId: null,
      role: "ASSISTANT",
      body: reply.content,
      markedSharedByOwner: false,
      redactedSummary: null,
    }).returning();

    const result = conversationTurnResponseSchema.parse({
      threadId: params.threadId,
      userMessage: toOwnerMessage(userMessage),
      assistantMessage: toOwnerMessage(assistantMessage),
      responseMode: reply.responseMode,
    });

    await tx.update(idempotencyRecords).set({
      entityId: assistantMessage.id,
      resultPayload: {
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        responseMode: reply.responseMode,
      },
    }).where(eq(idempotencyRecords.idempotencyKey, idempotencyKey));

    await recordAudit({
      ctx: params.ctx,
      action: "CHAT_MESSAGE_APPEND",
      actorUserId: params.ownerUserId,
      summary: {
        threadId: params.threadId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        messageCount: 2,
        responseMode: reply.responseMode,
      },
      tx,
    });

    return result;
  });

  if (persisted) return persisted;

  const concurrent = await loadStoredTurn(idempotencyKey, params.threadId);
  if (concurrent) return concurrent;
  throw new ApiError(409, "Conflict", "Conversation turn is already being processed");
}

export async function getOwnerConversation(params: {
  threadId: string;
  ownerUserId: string;
  limit?: number;
}) {
  const thread = await requireThreadOwner(params.threadId, params.ownerUserId);
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 100);
  const rows = await db.select().from(chatMessages)
    .where(eq(chatMessages.threadId, params.threadId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);

  return ownerConversationResponseSchema.parse({
    thread: toThreadSummary(thread),
    messages: rows.reverse().map(toOwnerMessage),
  });
}

async function requireThreadOwner(threadId: string, ownerUserId: string): Promise<ChatThreadRow> {
  const [thread] = await db.select().from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread) throw new ApiError(404, "Not Found", "Thread not found");
  if (thread.ownerUserId !== ownerUserId) {
    throw new ApiError(403, "Forbidden", "Not the owner of this thread");
  }
  return thread;
}

async function loadStoredTurn(
  idempotencyKey: string,
  threadId: string,
): Promise<ConversationTurnResponse | null> {
  const existing = await checkIdempotency(idempotencyKey);
  if (!existing.exists || !existing.result) return null;
  const stored = storedTurnResultSchema.safeParse(existing.result);
  if (!stored.success) return null;

  const rows = await db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.threadId, threadId),
      inArray(chatMessages.id, [stored.data.userMessageId, stored.data.assistantMessageId]),
    ));
  const userMessage = rows.find(row => row.id === stored.data.userMessageId);
  const assistantMessage = rows.find(row => row.id === stored.data.assistantMessageId);
  if (!userMessage || !assistantMessage) return null;

  return conversationTurnResponseSchema.parse({
    threadId,
    userMessage: toOwnerMessage(userMessage),
    assistantMessage: toOwnerMessage(assistantMessage),
    responseMode: stored.data.responseMode,
  });
}

function turnIdempotencyKey(threadId: string, requestId: string): string {
  return `chat_turn:${threadId}:${requestId}`;
}

function toOwnerMessage(row: typeof chatMessages.$inferSelect) {
  return {
    id: row.id,
    role: row.role,
    content: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

function toThreadSummary(row: ChatThreadRow) {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    tripId: row.tripId ?? null,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}
