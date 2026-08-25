import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../src/db/database.js";
import {
  users,
  chatThreads,
  chatMessages,
  auditEvents,
} from "../src/db/schema.js";
import { personalTravelAgent } from "../src/agents/personal-travel-agent.js";
import { createRequestContext } from "../src/utils/context.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { invokeSkill } from "../src/agents/skill-registry.js";
import { __resetRegistryForTests } from "../src/agents/skill-registry.js";

let ownerId: string;
let otherId: string;

beforeAll(async () => {
  // Register skills (process-wide; test runs against the same registry).
  personalTravelAgent.register();

  const [alice] = await db.insert(users)
    .values({ externalId: `skill-alice-${randomUUID()}`, displayName: "Skill Alice" })
    .returning();
  const [bob] = await db.insert(users)
    .values({ externalId: `skill-bob-${randomUUID()}`, displayName: "Skill Bob" })
    .returning();
  ownerId = alice.id;
  otherId = bob.id;
});

afterAll(async () => {
  await db.delete(chatThreads).where(inArray(chatThreads.ownerUserId, [ownerId, otherId]));
  await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, [ownerId, otherId]));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, otherId));
});

beforeEach(async () => {
  __resetRegistryForTests();
  personalTravelAgent.register();
  await db.delete(chatMessages);
  await db.delete(chatThreads);
});

describe("thread.recall skill", () => {
  it("returns empty array when the thread has no messages", async () => {
    const [thread] = await db.insert(chatThreads).values({
      ownerUserId: ownerId,
      title: "Empty",
    }).returning();

    const ctx = createRequestContext(ownerId, randomUUID(), randomUUID());
    const result = await invokeSkill("thread.recall", {
      ctx,
      policyGate: new DefaultPolicyGate("personal"),
    }, { threadId: thread.id, limit: 20 });

    expect(result.messages).toEqual([]);
  });

  it("returns contentRedacted='' for unshared messages", async () => {
    const [thread] = await db.insert(chatThreads).values({
      ownerUserId: ownerId,
      title: "Unshared",
    }).returning();

    await db.insert(chatMessages).values({
      threadId: thread.id,
      senderUserId: ownerId,
      role: "USER",
      body: "raw private content",
      markedSharedByOwner: false,
    });

    const ctx = createRequestContext(ownerId, randomUUID(), randomUUID());
    const result = await invokeSkill("thread.recall", {
      ctx,
      policyGate: new DefaultPolicyGate("personal"),
    }, { threadId: thread.id, limit: 20 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].contentRedacted).toBe("");
  });

  it("returns redacted_summary only when markedSharedByOwner && redactedSummary non-null", async () => {
    const [thread] = await db.insert(chatThreads).values({
      ownerUserId: ownerId,
      title: "Shared",
    }).returning();

    // Case 1: marked true but redacted_summary null → empty
    await db.insert(chatMessages).values({
      threadId: thread.id,
      senderUserId: ownerId,
      role: "USER",
      body: "raw 1",
      markedSharedByOwner: true,
      redactedSummary: null,
    });

    // Case 2: marked true and redacted_summary present → text
    await db.insert(chatMessages).values({
      threadId: thread.id,
      senderUserId: ownerId,
      role: "USER",
      body: "raw 2",
      markedSharedByOwner: true,
      redactedSummary: "redacted version 2",
    });

    const ctx = createRequestContext(ownerId, randomUUID(), randomUUID());
    const result = await invokeSkill("thread.recall", {
      ctx,
      policyGate: new DefaultPolicyGate("personal"),
    }, { threadId: thread.id, limit: 20 });

    expect(result.messages).toHaveLength(2);
    const contents = result.messages.map((m: { contentRedacted: string }) => m.contentRedacted);
    expect(contents).toContain("");
    expect(contents).toContain("redacted version 2");
  });

  it("owner mismatch returns 403, matching the owner-only thread routes", async () => {
    const [thread] = await db.insert(chatThreads).values({
      ownerUserId: ownerId,
      title: "Owned by alice",
    }).returning();

    // The handler throws ApiError directly, matching the HTTP route contract.
    const ctx = createRequestContext(otherId, randomUUID(), randomUUID());
    await expect(
      invokeSkill("thread.recall", {
        ctx,
        policyGate: new DefaultPolicyGate("personal"),
      }, { threadId: thread.id, limit: 20 }),
    ).rejects.toMatchObject({ statusCode: 403, message: "Not the owner of this thread" });
  });

  it("handler never leaks raw body — the output schema cannot carry it", async () => {
    const [thread] = await db.insert(chatThreads).values({
      ownerUserId: ownerId,
      title: "Leak test",
    }).returning();

    await db.insert(chatMessages).values({
      threadId: thread.id,
      senderUserId: ownerId,
      role: "USER",
      body: "extremely-private-secret-text-must-not-leak",
      markedSharedByOwner: true,
      redactedSummary: "redacted-and-safe",
    });

    const ctx = createRequestContext(ownerId, randomUUID(), randomUUID());
    const result = await invokeSkill("thread.recall", {
      ctx,
      policyGate: new DefaultPolicyGate("personal"),
    }, { threadId: thread.id, limit: 20 });

    const json = JSON.stringify(result);
    expect(json).not.toContain("extremely-private-secret-text-must-not-leak");
  });
});

// Ensure the registry doesn't carry state between vitest files.
afterAll(() => {
  __resetRegistryForTests();
});
