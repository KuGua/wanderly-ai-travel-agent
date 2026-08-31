import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/database.js";
import { staySearchProviderAuthorizations } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import {
  decryptQuoteNationality,
  encryptQuoteNationality,
} from "./quote-nationality-cipher.js";
import { recordAudit } from "./audit-service.js";
import { stalePlansAndConfirmationsForTrip } from "./consent-service.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type StaySearchProviderName = "nuitee_connect" | "serpapi_google_hotels";
export type StaySearchAuthorizationField = "guest_nationality";

export interface ActiveStaySearchAuthorization {
  id: string;
  tripId: string;
  memberId: string;
  providerName: StaySearchProviderName;
  field: StaySearchAuthorizationField;
  version: number;
  grantedAt: Date;
  expiresAt: Date | null;
}

/**
 * Persist a user-confirmed provider-only quote value (e.g. Nuitee
 * `guestNationality`). Plaintext is encrypted at rest; the response
 * intentionally never returns the decrypted value — only an id/version
 * pointer that downstream code uses to fetch the ciphertext in-process.
 *
 * Revoking any prior ACTIVE row for the same
 * `(trip, member, provider, field)` happens in the same transaction so
 * the new grant is the unique ACTIVE row. Dependent plans/confirmations
 * are STALE'd so a quote with a different nationality never ends up
 * attached to a stale plan.
 *
 * Spec §5.1 — provider-only quote nationality authorization.
 */
export async function grantQuoteNationality(params: {
  tripId: string;
  memberId: string;
  value: string;
  expiresAt?: Date;
}): Promise<{ id: string; version: number }> {
  const value = normalizeNationality(params.value);
  const ciphertext = encryptQuoteNationality(value);
  return db.transaction(async (tx) => {
    // Read the current max version for this tuple so the new row strictly
    // supersedes any prior ACTIVE row, instead of resetting to 1 and
    // forcing retry-based planners to compare on identity only.
    const [latest] = await tx.select({
      version: staySearchProviderAuthorizations.version,
    }).from(staySearchProviderAuthorizations)
      .where(and(
        eq(staySearchProviderAuthorizations.tripId, params.tripId),
        eq(staySearchProviderAuthorizations.memberId, params.memberId),
        eq(staySearchProviderAuthorizations.providerName, "nuitee_connect"),
        eq(staySearchProviderAuthorizations.field, "guest_nationality"),
      ))
      .orderBy(sql`${staySearchProviderAuthorizations.version} DESC`)
      .limit(1);
    const nextVersion = (latest?.version ?? 0) + 1;

    // Revoke prior ACTIVE row(s) for this tuple.
    await tx.update(staySearchProviderAuthorizations)
      .set({
        status: "REVOKED",
        revokedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(staySearchProviderAuthorizations.tripId, params.tripId),
        eq(staySearchProviderAuthorizations.memberId, params.memberId),
        eq(staySearchProviderAuthorizations.providerName, "nuitee_connect"),
        eq(staySearchProviderAuthorizations.field, "guest_nationality"),
        eq(staySearchProviderAuthorizations.status, "ACTIVE"),
      ));
    const [row] = await tx.insert(staySearchProviderAuthorizations).values({
      tripId: params.tripId,
      memberId: params.memberId,
      providerName: "nuitee_connect",
      field: "guest_nationality",
      valueEncrypted: ciphertext,
      status: "ACTIVE",
      version: nextVersion,
      ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
    }).returning();
    if (!row) throw new ApiError(500, "Internal Server Error", "Failed to persist provider authorization");
    await stalePlansAndConfirmationsForTrip(tx, {
      tripId: params.tripId,
      reason: "quote_nationality_changed",
    });
    await recordAudit({
      ctx: { correlationId: randomUUID(), actorUserId: params.memberId },
      action: "HOTEL_PROVIDER_GRANTED",
      actorUserId: params.memberId,
      tripId: params.tripId,
      summary: { provider: "nuitee_connect", field: "guest_nationality", version: row.version },
      tx,
    });
    return { id: row.id, version: row.version };
  });
}

/**
 * Mark the current ACTIVE authorization as REVOKED. Dependent plans
 * become STALE so a quote attempt in flight cannot finish against an
 * authorization the user has rescinded.
 */
export async function revokeQuoteNationality(params: {
  tripId: string;
  memberId: string;
  authorizationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(staySearchProviderAuthorizations)
      .set({ status: "REVOKED", revokedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(staySearchProviderAuthorizations.id, params.authorizationId),
        eq(staySearchProviderAuthorizations.tripId, params.tripId),
        eq(staySearchProviderAuthorizations.memberId, params.memberId),
        eq(staySearchProviderAuthorizations.status, "ACTIVE"),
      ))
      .returning({ id: staySearchProviderAuthorizations.id });
    if (!row) throw new ApiError(404, "Not Found", "Authorization not found or already revoked");
    await stalePlansAndConfirmationsForTrip(tx, {
      tripId: params.tripId,
      reason: "quote_nationality_changed",
    });
    await recordAudit({
      ctx: { correlationId: randomUUID(), actorUserId: params.memberId },
      action: "HOTEL_PROVIDER_REVOKED",
      actorUserId: params.memberId,
      tripId: params.tripId,
      summary: { provider: "nuitee_connect", field: "guest_nationality" },
      tx,
    });
  });
}

/**
 * Resolve the active authorization for the current
 * `(trip, member, provider, field)` tuple and decrypt the value server-side.
 * Returns `null` when no active row exists, the row is EXPIRED, or the
 * ciphertext cannot be decrypted (which is treated as
 * `SEARCH_CONSTRAINTS_INCOMPLETE` upstream — never a partial answer).
 *
 * This is the SOLE call site that exposes the plaintext nationality;
 * the value lives only in the local variable below for the lifetime of
 * the adapter call.
 */
export async function loadActiveQuoteNationality(params: {
  tripId: string;
  memberId: string;
  now?: Date;
}): Promise<{ id: string; version: number; nationality: string } | null> {
  const now = params.now ?? new Date();
  const [row] = await db.select().from(staySearchProviderAuthorizations).where(and(
    eq(staySearchProviderAuthorizations.tripId, params.tripId),
    eq(staySearchProviderAuthorizations.memberId, params.memberId),
    eq(staySearchProviderAuthorizations.providerName, "nuitee_connect"),
    eq(staySearchProviderAuthorizations.field, "guest_nationality"),
    eq(staySearchProviderAuthorizations.status, "ACTIVE"),
  )).limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  try {
    const nationality = decryptQuoteNationality(row.valueEncrypted);
    return { id: row.id, version: row.version, nationality };
  } catch {
    return null;
  }
}

/**
 * List authorizations for a (trip, member) tuple. The response shape
 * intentionally omits the decrypted value so the route layer cannot
 * accidentally echo the nationality back to the browser.
 */
export async function listStaySearchAuthorizations(params: {
  tripId: string;
  memberId: string;
}): Promise<ActiveStaySearchAuthorization[]> {
  const rows = await db.select().from(staySearchProviderAuthorizations).where(and(
    eq(staySearchProviderAuthorizations.tripId, params.tripId),
    eq(staySearchProviderAuthorizations.memberId, params.memberId),
    eq(staySearchProviderAuthorizations.status, "ACTIVE"),
  ));
  return rows.map((row) => ({
    id: row.id,
    tripId: row.tripId,
    memberId: row.memberId,
    providerName: row.providerName as StaySearchProviderName,
    field: row.field as StaySearchAuthorizationField,
    version: row.version,
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt,
  }));
}

function normalizeNationality(value: string): string {
  const trimmed = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(trimmed)) {
    throw new ApiError(422, "Unprocessable Entity", "guest_nationality must be an ISO-3166-1 alpha-2 code");
  }
  return trimmed;
}

export const __test = { normalizeNationality };
