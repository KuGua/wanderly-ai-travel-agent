import type { FastifyRequest } from "fastify";
import { db } from "../db/database.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { DEMO_USERS } from "../providers/fixtures.js";
import { ApiError } from "./error-handler.js";

/**
 * Demo auth middleware.
 * In production, this would validate Cognito JWTs.
 * For MVP, accepts X-Demo-User header with demo user externalId.
 */
export async function demoAuthMiddleware(request: FastifyRequest) {
  const demoUser = request.headers["x-demo-user"] as string | undefined;

  if (!demoUser) {
    throw new ApiError(401, "Unauthorized", "Missing X-Demo-User header. Use one of: alice, bob, chen");
  }

  const demoConfig = DEMO_USERS.find(u => u.externalId === demoUser);
  if (!demoConfig) {
    throw new ApiError(
      401,
      "Unauthorized",
      `Invalid demo user. Use one of: ${DEMO_USERS.map(u => u.externalId).join(", ")}`,
    );
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
  request.user = {
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
