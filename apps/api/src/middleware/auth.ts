import type { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/database.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

// Demo users for MVP (Cognito integration future)
const DEMO_USERS = [
  { externalId: "alice", displayName: "Alice" },
  { externalId: "bob", displayName: "Bob" },
  { externalId: "chen", displayName: "Chen" },
];

/**
 * Demo auth middleware.
 * In production, this would validate Cognito JWTs.
 * For MVP, accepts X-Demo-User header with demo user externalId.
 */
export async function demoAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const demoUser = request.headers["x-demo-user"] as string | undefined;

  if (!demoUser) {
    reply.code(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: "Missing X-Demo-User header. Use one of: alice, bob, chen",
    });
    return;
  }

  const demoConfig = DEMO_USERS.find(u => u.externalId === demoUser);
  if (!demoConfig) {
    reply.code(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: `Invalid demo user. Use one of: ${DEMO_USERS.map(u => u.externalId).join(", ")}`,
    });
    return;
  }

  // Find or create user in DB
  let userRecords = await db.select().from(users).where(eq(users.externalId, demoConfig.externalId)).limit(1);
  
  if (userRecords.length === 0) {
    const [newUser] = await db.insert(users).values({
      externalId: demoConfig.externalId,
      displayName: demoConfig.displayName,
    }).returning();
    userRecords = [newUser];
  }

  // Attach user to request
  (request as any).user = {
    id: userRecords[0].id,
    externalId: userRecords[0].externalId,
    displayName: userRecords[0].displayName,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    user: {
      id: string;
      externalId: string;
      displayName: string;
    };
  }
}
