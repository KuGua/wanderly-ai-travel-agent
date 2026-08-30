import { z } from "zod";
import type { Skill, SkillContext } from "../../agents/contracts.js";
import { SkillError } from "../../agents/errors.js";
import {
  PlaceCandidateStaleError,
  PlaceNotFoundError,
  PlaceVisibilityDeniedError,
  adoptTripPlaceInputSchema,
  adoptTripPlace,
  proposeTripPlaceInputSchema,
  proposeTripPlace,
  revokeTripPlaceInputSchema,
  revokeTripPlace,
} from "../../services/trip-place-service.js";
import { recordAudit } from "../../services/audit-service.js";
import type { PlaceCandidate } from "../../types/domain.js";

/**
 * Spec §4.1 — Shared `places.adopt` skill.
 *
 * Three actions: `propose`, `adopt`, `revoke`. All three operate on
 * server-internal place ids or run-bound `candidateId`s; the model never
 * receives raw provider coordinates, attribution, or external URLs.
 *
 * `adopt` and `revoke` flip the dependent plan + confirmations into `STALE`
 * in the same transaction so downstream route evidence can never outlive
 * its referenced place.
 */
const actionSchema = z.enum(["propose", "adopt", "revoke"]);

const tripPlaceSkillInputSchema = z.discriminatedUnion("action", [
  proposeTripPlaceInputSchema.extend({ action: z.literal("propose"), candidate: z.object({
    candidateId: z.string().uuid(),
    displayName: z.string().min(1).max(256),
    kind: z.enum(["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"]),
    countryCode: z.string().length(2).nullable(),
    cityName: z.string().min(1).max(128).nullable(),
    longitude: z.number().finite().min(-180).max(180),
    latitude: z.number().finite().min(-90).max(90),
    confidence: z.number().min(0).max(1),
    needsUserConfirmation: z.boolean(),
    source: z.string().min(1),
    capturedAt: z.string().datetime({ offset: true }),
  }).strict() }).strict(),
  adoptTripPlaceInputSchema.extend({ action: z.literal("adopt") }).strict(),
  revokeTripPlaceInputSchema.extend({ action: z.literal("revoke") }).strict(),
]);
export type TripPlaceSkillInput = z.infer<typeof tripPlaceSkillInputSchema>;

/**
 * LLM-facing tool-arguments schema for `places.adopt`. Mirrors the skill input
 * verbatim (snapshotId is server-injected by the dispatcher through ctx). The
 * `places.search` candidate envelope is preserved so the model can echo back
 * the full POI shape it received earlier in the same tool loop.
 */
export const tripPlaceModelArgumentsSchema: z.ZodType<TripPlaceSkillInput> = tripPlaceSkillInputSchema;

export const tripPlaceSkillOutputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ACCEPTED"), placeId: z.string().uuid() }).strict(),
  z.object({ outcome: z.literal("REVOKED"), placeId: z.string().uuid() }).strict(),
  z.object({ outcome: z.literal("REJECTED"), code: z.enum(["PLACE_NOT_FOUND", "PLACE_VISIBILITY_DENIED", "PLACE_CANDIDATE_STALE", "PLACE_NOT_ADOPTABLE"]) }).strict(),
]);
export type TripPlaceSkillOutput = z.infer<typeof tripPlaceSkillOutputSchema>;

export function createTripPlaceSkill(): Skill<TripPlaceSkillInput, TripPlaceSkillOutput> {
  return {
    name: "places.adopt",
    agent: "shared",
    version: "1.0.0",
    allowedTools: ["snapshot:read", "places:search", "places:adopt", "plan:write:propose"],
    timeoutMs: 8_000,
    needsConfirm: false,
    input: tripPlaceSkillInputSchema,
    output: tripPlaceSkillOutputSchema,
    async handler(ctx, input) {
      return executeTripPlaceSkill(ctx, input);
    },
  };
}

async function executeTripPlaceSkill(
  ctx: SkillContext,
  input: TripPlaceSkillInput,
): Promise<TripPlaceSkillOutput> {
  if (!ctx.snapshot || !ctx.placeSearch) {
    throw new SkillError("POLICY_DENIED", "places.adopt requires an authorized Shared planning execution context");
  }
  if (input.action === "propose") {
    const candidate: PlaceCandidate = {
      candidateId: input.candidate.candidateId,
      displayName: input.candidate.displayName,
      kind: input.candidate.kind,
      countryCode: input.candidate.countryCode,
      cityName: input.candidate.cityName,
      longitude: input.candidate.longitude,
      latitude: input.candidate.latitude,
      confidence: input.candidate.confidence,
      needsUserConfirmation: input.candidate.needsUserConfirmation,
      source: input.candidate.source,
      capturedAt: input.candidate.capturedAt,
    };
    const placeId = await proposeTripPlace({
      ctx: ctx.ctx,
      tripId: ctx.placeSearch.tripId,
      ownerUserId: ctx.ctx.actorUserId ?? "",
      snapshotId: ctx.placeSearch.snapshotId,
      agentTaskRunId: ctx.placeSearch.agentTaskRunId,
      candidate,
      visibility: input.visibility,
      kind: input.kind,
    });
    await recordAudit({
      ctx: ctx.ctx,
      action: "TRIP_PLACE_PROPOSED",
      tripId: ctx.placeSearch.tripId,
      summary: { placeId, visibility: input.visibility, kind: input.kind },
    });
    return { outcome: "ACCEPTED", placeId };
  }
  if (input.action === "adopt") {
    try {
      await adoptTripPlace({
        ctx: ctx.ctx,
        tripId: ctx.placeSearch.tripId,
        placeId: input.placeId,
      });
    } catch (error) {
      if (error instanceof PlaceNotFoundError) {
        return { outcome: "REJECTED", code: "PLACE_NOT_FOUND" };
      }
      if (error instanceof PlaceVisibilityDeniedError) {
        return { outcome: "REJECTED", code: "PLACE_VISIBILITY_DENIED" };
      }
      if (error instanceof PlaceCandidateStaleError) {
        return { outcome: "REJECTED", code: "PLACE_CANDIDATE_STALE" };
      }
      if ((error as Error).message?.startsWith("adoptTripPlace")) {
        return { outcome: "REJECTED", code: "PLACE_NOT_ADOPTABLE" };
      }
      throw error;
    }
    await recordAudit({
      ctx: ctx.ctx,
      action: "TRIP_PLACE_ADOPTED",
      tripId: ctx.placeSearch.tripId,
      summary: { placeId: input.placeId },
    });
    return { outcome: "ACCEPTED", placeId: input.placeId };
  }
  // action === "revoke"
  try {
    await revokeTripPlace({
      ctx: ctx.ctx,
      tripId: ctx.placeSearch.tripId,
      placeId: input.placeId,
      reason: input.reason,
    });
  } catch (error) {
    if (error instanceof PlaceNotFoundError) {
      return { outcome: "REJECTED", code: "PLACE_NOT_FOUND" };
    }
    throw error;
  }
  await recordAudit({
    ctx: ctx.ctx,
    action: "TRIP_PLACE_REVOKED",
    tripId: ctx.placeSearch.tripId,
    summary: { placeId: input.placeId, reason: input.reason },
  });
  return { outcome: "REVOKED", placeId: input.placeId };
}

export const tripPlaceSkill = createTripPlaceSkill();
export { actionSchema };
