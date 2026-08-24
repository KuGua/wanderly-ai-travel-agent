import type { FastifyInstance } from "fastify";
import { inArray } from "drizzle-orm";
import { db } from "../db/database.js";
import { users } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import { DEMO_USERS } from "../providers/fixtures.js";
import { demoUsersResponseSchema, errorResponseSchema, toJsonSchema } from "../types/schemas.js";

const demoUserOrder = new Map(DEMO_USERS.map((user, index) => [user.externalId, index]));

export async function demoUserRoutes(app: FastifyInstance) {
  app.get("/demo/users", {
    schema: {
      description: "List the safe seeded identities available for the MVP demo selector.",
      response: {
        200: toJsonSchema(demoUsersResponseSchema),
        500: toJsonSchema(errorResponseSchema),
      },
    },
  }, async () => {
    const configuredExternalIds = DEMO_USERS.map(user => user.externalId);
    const records = await db.select({
      id: users.id,
      externalId: users.externalId,
      displayName: users.displayName,
    }).from(users).where(inArray(users.externalId, configuredExternalIds));

    if (records.length !== DEMO_USERS.length) {
      throw new ApiError(500, "Internal Server Error", "Seeded demo users are unavailable");
    }

    records.sort((left, right) =>
      (demoUserOrder.get(left.externalId) ?? Number.MAX_SAFE_INTEGER)
      - (demoUserOrder.get(right.externalId) ?? Number.MAX_SAFE_INTEGER));

    return demoUsersResponseSchema.parse({ users: records });
  });
}
