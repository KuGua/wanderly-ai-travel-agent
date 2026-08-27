import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import type { Skill } from "../../agents/contracts.js";
import { db } from "../../db/database.js";
import { chatMessages } from "../../db/schema.js";
import { chatMessageRoleSchema } from "../../types/schemas.js";
import { requireOwnedTripThreadRead } from "../../services/chat-thread-service.js";

export const threadRecallInputSchema = z.object({
  threadId: z.string().uuid(),
  limit: z.number().int().positive().max(100).default(20),
}).strict();

export const threadRecallOutputSchema = z.object({
  messages: z.array(z.object({
    id: z.string().uuid(),
    role: chatMessageRoleSchema,
    contentRedacted: z.string(),
    createdAt: z.string().datetime(),
  })),
}).strict();

export type ThreadRecallInput = z.infer<typeof threadRecallInputSchema>;
export type ThreadRecallOutput = z.infer<typeof threadRecallOutputSchema>;

export const threadRecallSkill: Skill<ThreadRecallInput, ThreadRecallOutput> = {
  name: "thread.recall",
  agent: "personal",
  version: "1.0.0",
  allowedTools: ["chat:read"],
  timeoutMs: 2000,
  needsConfirm: false,
  input: threadRecallInputSchema,
  output: threadRecallOutputSchema,
  async handler({ ctx }, input) {
    // Ownership + Trip-membership check delegated to the shared helper.
    // Throws 404 when the thread does not exist; 403 when the caller is
    // not the owner or is no longer an active member of the thread's
    // trip — never 404 in place of 403 to avoid enumeration.
    // `ctx` here is the RequestContext (SkillContext is the outer arg);
    // actorUserId is optional but the skill is always invoked from an
    // authenticated task, so it must be present.
    const actorUserId = ctx.actorUserId;
    if (!actorUserId) {
      throw new Error("Skill invoked without an authenticated actor");
    }
    await requireOwnedTripThreadRead(input.threadId, actorUserId);

    const rows = await db.select({
      id: chatMessages.id,
      role: chatMessages.role,
      redactedSummary: chatMessages.redactedSummary,
      markedSharedByOwner: chatMessages.markedSharedByOwner,
      createdAt: chatMessages.createdAt,
    })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, input.threadId))
      .orderBy(desc(chatMessages.messageSequence))
      .limit(input.limit);

    // Reverse to chronological order (oldest first) for the caller.
    // contentRedacted is intentionally NEVER the raw body: only the
    // server-derived redactedSummary surfaces, and only when the owner
    // has explicitly marked the message as shared. The raw body stays
    // in the database but never crosses this Skill boundary.
    return {
      messages: rows.reverse().map(r => ({
        id: r.id,
        role: chatMessageRoleSchema.parse(r.role),
        contentRedacted:
          r.markedSharedByOwner && r.redactedSummary ? r.redactedSummary : "",
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
};
