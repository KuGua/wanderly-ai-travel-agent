import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import { chatMessages, chatThreads, users } from "../src/db/schema.js";
import { LOCAL_DEV_EXTERNAL_ID } from "../src/middleware/auth-mode.js";

const originalAuthMode = process.env.AUTH_MODE;
let app: FastifyInstance;
let localThreadId: string;
let foreignThreadId: string;

beforeAll(async () => {
  process.env.AUTH_MODE = "local-dev";
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  if (localThreadId) await db.delete(chatMessages).where(eq(chatMessages.threadId, localThreadId));
  if (foreignThreadId) await db.delete(chatMessages).where(eq(chatMessages.threadId, foreignThreadId));
  if (localThreadId) await db.delete(chatThreads).where(eq(chatThreads.id, localThreadId));
  if (foreignThreadId) await db.delete(chatThreads).where(eq(chatThreads.id, foreignThreadId));
  await app.close();
  if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = originalAuthMode;
});

describe("strict local development authentication", () => {
  it("provisions one server-owned identity and ignores client identity/auth headers", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: {
        authorization: "Bearer browser-fabricated-token",
        "x-user-id": randomUUID(),
        "x-demo-user": "attacker",
        "content-type": "application/json",
      },
      payload: { title: "Local development thread" },
    });

    expect(response.statusCode).toBe(201);
    localThreadId = (response.json() as { id: string }).id;
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, localThreadId)).limit(1);
    const [owner] = await db.select().from(users).where(eq(users.id, thread.ownerUserId)).limit(1);
    expect(owner.externalId).toBe(LOCAL_DEV_EXTERNAL_ID);
  });

  it("keeps owner-only thread authorization active", async () => {
    const externalId = `foreign-${randomUUID()}`;
    const [foreignOwner] = await db.insert(users).values({ externalId, displayName: "Foreign Owner" }).returning();
    const [foreignThread] = await db.insert(chatThreads).values({
      ownerUserId: foreignOwner.id,
      title: "Foreign private thread",
    }).returning();
    foreignThreadId = foreignThread.id;

    const response = await app.inject({ method: "GET", url: `/api/v1/threads/${foreignThreadId}` });
    expect(response.statusCode).toBe(403);
  });
});
