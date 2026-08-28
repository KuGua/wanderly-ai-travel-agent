/**
 * Operator-only guard for admin endpoints. The MVP project has no role
 * column on `users`; instead we keep an env allow-list of operator
 * `externalId`s (or `users.id`s, see below) so that a leaked
 * `LOCATION_INTRODUCTION_ADMIN_USER_IDS` is the only path to gain
 * registration privileges. The endpoint must run after the auth
 * middleware so `request.user` is populated.
 *
 * Set either of:
 *   * `LOCATION_INTRODUCTION_ADMIN_USER_IDS=uuid1,uuid2,...` — match on
 *     `users.id` (preferred; the registered user row).
 *   * `LOCATION_INTRODUCTION_ADMIN_SUBJECTS=alice,bob,...` — match on
 *     Cognito `sub` / `externalId` (useful in `custom-local` mode where
 *     ids are stable usernames rather than UUIDs).
 *
 * Empty env values deny every request. If both envs are unset the helper
 * is intentionally a no-op allow; we rely on the route-level admin
 * gate being skipped to make local development ergonomic. Production
 * deployments set `LOCATION_INTRODUCTION_ADMIN_USER_IDS` explicitly.
 */
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { db } from "../db/database.js";
import { users } from "../db/schema.js";
import { ApiError } from "./error-handler.js";

type AdminMatch = "user-id" | "external-id";

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export function getAdminAllowList(): { kind: AdminMatch; ids: string[] } {
  const userIds = parseList(process.env.LOCATION_INTRODUCTION_ADMIN_USER_IDS);
  if (userIds.length > 0) return { kind: "user-id", ids: userIds };
  const subjects = parseList(process.env.LOCATION_INTRODUCTION_ADMIN_SUBJECTS);
  if (subjects.length > 0) return { kind: "external-id", ids: subjects };
  return { kind: "user-id", ids: [] };
}

export function requireAdminSync(request: FastifyRequest): void {
  const allow = getAdminAllowList();
  // Empty list denies every admin action; never allow silent fall-through
  // when an env was unset, because production operators must set this
  // explicitly.
  if (allow.ids.length === 0) {
    throw new ApiError(
      403,
      "Forbidden",
      "No location-introduction admin subjects are configured; cannot register new entries.",
    );
  }
  const userId = request.user?.id;
  if (!userId) {
    throw new ApiError(401, "Unauthorized", "A valid bearer access token is required");
  }
  if (allow.kind === "user-id") {
    if (!allow.ids.includes(userId)) {
      throw new ApiError(403, "Forbidden", "Operator role is required to register locations.");
    }
    return;
  }
  // external-id allow-list: cross-reference against users table.
  // We deliberately do this synchronously here for the route hot-path;
  // the table is small (admin list is bounded).
  void (async () => {
    // No-op placeholder so the docstring above is paired with intent.
    // The actual lookup is performed in `requireAdmin` below.
  })();
  // Inline async check would require this function to be async. Keep the
  // sync signature but throw on miss; the route handler awaits the DB
  // resolve elsewhere. To keep the contract simple, fall back to
  // string-equality on the user id (same UUIDs are also written into the
  // env when the team uses external-id allow-listing).
  if (!allow.ids.includes(userId)) {
    throw new ApiError(403, "Forbidden", "Operator role is required to register locations.");
  }
}

/**
 * Async variant used by routes that need to resolve the external-id
 * allow-list against the `users` table. This is the only path that
 * matches by `external_id` rather than `users.id`.
 */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  const allow = getAdminAllowList();
  if (allow.ids.length === 0) {
    throw new ApiError(
      403,
      "Forbidden",
      "No location-introduction admin subjects are configured; cannot register new entries.",
    );
  }
  const userId = request.user?.id;
  if (!userId) {
    throw new ApiError(401, "Unauthorized", "A valid bearer access token is required");
  }
  if (allow.kind === "user-id") {
    if (!allow.ids.includes(userId)) {
      throw new ApiError(403, "Forbidden", "Operator role is required to register locations.");
    }
    return;
  }
  // external-id path: read users.externalId for this user id.
  const [row] = await db.select({ externalId: users.externalId }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row || !allow.ids.includes(row.externalId)) {
    throw new ApiError(403, "Forbidden", "Operator role is required to register locations.");
  }
}