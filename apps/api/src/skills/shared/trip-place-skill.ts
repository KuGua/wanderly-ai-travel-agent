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
 * receives raw provider coordinates, attribution, or external URLs — and, for
 * `propose`, never supplies them either: the caller passes the run's candidate
 * store through `ctx.placeSearch.resolveCandidate` and the skill looks the id
 * up itself. It used to accept the candidate's own fields from its caller,
 * which on the planning path is the model, so invented coordinates and an
 * invented `source` would have been persisted as trip evidence.
 *
 * `adopt` and `revoke` flip the dependent plan + confirmations into `STALE`
 * in the same transaction so downstream route evidence can never outlive
 * its referenced place.
 */
const actionSchema = z.enum(["propose", "adopt", "revoke"]);

const tripPlaceSkillInputSchema = z.discriminatedUnion("action", [
  proposeTripPlaceInputSchema.extend({ action: z.literal("propose") }).strict(),
  adoptTripPlaceInputSchema.extend({ action: z.literal("adopt") }).strict(),
  revokeTripPlaceInputSchema.extend({ action: z.literal("revoke") }).strict(),
]);
export type TripPlaceSkillInput = z.infer<typeof tripPlaceSkillInputSchema>;

/**
 * LLM-facing tool-arguments schema. Mirrors the skill input verbatim
 * (snapshotId is server-injected by the dispatcher through ctx).
 *
 * The planning tool loop does not offer this union to the model. It offers
 * `places.propose` / `places.adopt` / `places.revoke` as three flat tools and
 * adds the `action` itself — see `buildPlanningToolDefinitions`. This schema
 * stays the single validator both paths parse through.
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
    if (!ctx.placeSearch.resolveCandidate) {
      throw new SkillError("POLICY_DENIED", "places.adopt propose requires the run's candidate store");
    }
    // An id this run's `places.search` never issued is refused here rather
    // than trusted: it is either a stale candidate from another run or one the
    // caller invented, and both would persist a place with no provider behind
    // it. `INPUT_INVALID` (not a provider code) so the gap is attributed to
    // the request, which is where the repair is.
    const candidate: PlaceCandidate | undefined = ctx.placeSearch.resolveCandidate(input.candidateId);
    if (!candidate) {
      throw new SkillError("INPUT_INVALID", "candidateId was not returned by places.search in this run");
    }
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
