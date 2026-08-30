import { describe, expect, it } from "vitest";

import { buildMemoryNamespace } from "../src/services/memory-projection-builder.js";
import {
  MemoryProjectionUnavailableError,
  memberPlanningPreferences,
  readMemoryProjection,
  tripWidePreferences,
} from "../src/skills/shared/memory-projection-input.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const aliases = { [ALICE]: "m-alice", [BOB]: "m-bob" } as const;

function build(overrides: Partial<Parameters<typeof buildMemoryNamespace>[0]> = {}) {
  return buildMemoryNamespace({
    aliases,
    consentedFieldsByUser: {},
    preferenceFacts: [],
    tripFacts: [],
    ...overrides,
  });
}

describe("buildMemoryNamespace", () => {
  it("gives every member a bucket even with nothing to project", () => {
    // A stable shape keeps a member's absence from looking like a member who
    // does not exist.
    expect(build()).toEqual({
      members: {
        "m-alice": { profileFacts: {}, tripOverrides: {}, confidentialOverrides: {} },
        "m-bob": { profileFacts: {}, tripOverrides: {}, confidentialOverrides: {} },
      },
      groupDecisions: {},
    });
  });

  it("projects a consented profile fact", () => {
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["trip_pace"] },
      preferenceFacts: [{ userId: ALICE, fieldKey: "trip_pace", value: "relaxed" }],
    });
    expect(projection.members["m-alice"].profileFacts).toEqual({ trip_pace: "relaxed" });
  });

  it("withholds a profile fact the member never consented to export", () => {
    // The fact exists and the field is exportable; consent is the missing
    // piece, and it alone has to be enough to keep it out.
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["accommodation_style"] },
      preferenceFacts: [{ userId: ALICE, fieldKey: "trip_pace", value: "relaxed" }],
    });
    expect(projection.members["m-alice"].profileFacts).toEqual({});
  });

  it("withholds a sensitive fact even when consent names it", () => {
    // Nationality is registered `consentExportable: false`. A consent row
    // naming it must not be able to override the catalog.
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["nationality", "date_of_birth", "mobility_notes"] },
      preferenceFacts: [
        { userId: ALICE, fieldKey: "nationality", value: "Singapore" },
        { userId: ALICE, fieldKey: "date_of_birth", value: "1990-01-01" },
        { userId: ALICE, fieldKey: "mobility_notes", value: "step-free access" },
      ],
    });
    expect(projection.members["m-alice"].profileFacts).toEqual({});
  });

  it("withholds a field the catalog does not know", () => {
    // Fail closed: adding a row to the table must not be enough to reach a
    // shared plan.
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["astrological_sign"] },
      preferenceFacts: [{ userId: ALICE, fieldKey: "astrological_sign", value: "leo" }],
    });
    expect(projection.members["m-alice"].profileFacts).toEqual({});
  });

  it("does not project a non-member's fact", () => {
    const projection = build({
      consentedFieldsByUser: { "99999999-9999-4999-8999-999999999999": ["trip_pace"] },
      preferenceFacts: [{
        userId: "99999999-9999-4999-8999-999999999999",
        fieldKey: "trip_pace",
        value: "packed",
      }],
    });
    expect(Object.keys(projection.members)).toEqual(["m-alice", "m-bob"]);
  });

  it("files a confidential override apart from the team-visible ones", () => {
    // Trip overrides are saved ORCHESTRATOR_CONFIDENTIAL. Mixing them into
    // `tripOverrides` would leave a consumer unable to tell which values it may
    // repeat back to the team.
    const projection = build({
      tripFacts: [{
        ownerUserId: BOB, fieldKey: "trip_pace",
        kind: "PERSONAL_OVERRIDE", visibility: "ORCHESTRATOR_CONFIDENTIAL",
        valueJson: { value: "packed" },
      }],
    });
    expect(projection.members["m-bob"].confidentialOverrides).toEqual({ trip_pace: "packed" });
    expect(projection.members["m-bob"].tripOverrides).toEqual({});
    expect(projection.members["m-alice"].confidentialOverrides).toEqual({});
  });

  it("files a team-visible override where it can be referenced", () => {
    const projection = build({
      tripFacts: [{
        ownerUserId: BOB, fieldKey: "trip_pace",
        kind: "PERSONAL_OVERRIDE", visibility: "TEAM_VISIBLE",
        valueJson: { value: "packed" },
      }],
    });
    expect(projection.members["m-bob"].tripOverrides).toEqual({ trip_pace: "packed" });
    expect(projection.members["m-bob"].confidentialOverrides).toEqual({});
  });

  it("files a group decision against the trip, not a member", () => {
    const projection = build({
      tripFacts: [{
        ownerUserId: ALICE, fieldKey: "accommodation_style",
        kind: "GROUP_DECISION", visibility: "TEAM_VISIBLE", valueJson: { value: "budget" },
      }],
    });
    expect(projection.groupDecisions).toEqual({ accommodation_style: "budget" });
    expect(projection.members["m-alice"].tripOverrides).toEqual({});
  });

  it("ignores orchestration constraints, which project through their own path", () => {
    const projection = build({
      tripFacts: [{
        ownerUserId: ALICE, fieldKey: "trip_pace",
        kind: "MEMBER_CONSTRAINT", visibility: "TEAM_VISIBLE", valueJson: { pace: "packed" },
      }],
    });
    expect(projection.members["m-alice"].tripOverrides).toEqual({});
    expect(projection.members["m-alice"].confidentialOverrides).toEqual({});
    expect(projection.groupDecisions).toEqual({});
  });

  it("never carries a user id", () => {
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["trip_pace"] },
      preferenceFacts: [{ userId: ALICE, fieldKey: "trip_pace", value: "relaxed" }],
    });
    expect(JSON.stringify(projection)).not.toContain(ALICE);
  });
});

describe("readMemoryProjection", () => {
  it("reads the namespace a snapshot carries", () => {
    const memory = build({
      consentedFieldsByUser: { [ALICE]: ["trip_pace"] },
      preferenceFacts: [{ userId: ALICE, fieldKey: "trip_pace", value: "relaxed" }],
    });
    expect(readMemoryProjection({ _meta: { memory } })).toEqual(memory);
  });

  it("plans without preferences on a snapshot taken before the namespace existed", () => {
    // An older snapshot should still be plannable, just without memory.
    expect(readMemoryProjection({ _meta: { schemaVersion: 2 } }))
      .toEqual({ members: {}, groupDecisions: {} });
    expect(readMemoryProjection({})).toEqual({ members: {}, groupDecisions: {} });
    expect(readMemoryProjection(null)).toEqual({ members: {}, groupDecisions: {} });
  });

  it("refuses a namespace whose shape it does not recognise", () => {
    // The snapshot is a JSONB blob. Without a parse, whatever landed in
    // `_meta.memory` would be handed to the model as-is.
    expect(() => readMemoryProjection({ _meta: { memory: { members: "nope" } } }))
      .toThrow(MemoryProjectionUnavailableError);
    expect(() => readMemoryProjection({
      _meta: { memory: { members: {}, groupDecisions: {}, secrets: {} } },
    })).toThrow(MemoryProjectionUnavailableError);
  });
});

describe("tripWidePreferences", () => {
  it("returns a value every member agrees on", () => {
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["trip_pace"], [BOB]: ["trip_pace"] },
      preferenceFacts: [
        { userId: ALICE, fieldKey: "trip_pace", value: "relaxed" },
        { userId: BOB, fieldKey: "trip_pace", value: "relaxed" },
      ],
    });
    expect(tripWidePreferences(projection)).toEqual({ trip_pace: "relaxed" });
  });

  it("returns nothing when members disagree", () => {
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["trip_pace"], [BOB]: ["trip_pace"] },
      preferenceFacts: [
        { userId: ALICE, fieldKey: "trip_pace", value: "relaxed" },
        { userId: BOB, fieldKey: "trip_pace", value: "packed" },
      ],
    });
    expect(tripWidePreferences(projection)).toEqual({});
  });

  it("treats silence as absence rather than assent", () => {
    // Only Alice stated a pace. Applying it to the whole trip would impose one
    // member's preference on a group that never agreed to it.
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["trip_pace"] },
      preferenceFacts: [{ userId: ALICE, fieldKey: "trip_pace", value: "relaxed" }],
    });
    expect(tripWidePreferences(projection)).toEqual({});
  });

  it("never derives a trip-wide value from a confidential override", () => {
    // Bob's confidential override would complete a unanimous pace. Publishing
    // that as a trip-wide value tells the team what he privately set, by
    // inference — which is the thing ORCHESTRATOR_CONFIDENTIAL forbids.
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["trip_pace"], [BOB]: ["trip_pace"] },
      preferenceFacts: [
        { userId: ALICE, fieldKey: "trip_pace", value: "relaxed" },
        { userId: BOB, fieldKey: "trip_pace", value: "packed" },
      ],
      tripFacts: [{
        ownerUserId: BOB, fieldKey: "trip_pace",
        kind: "PERSONAL_OVERRIDE", visibility: "ORCHESTRATOR_CONFIDENTIAL",
        valueJson: { value: "relaxed" },
      }],
    });

    expect(tripWidePreferences(projection)).toEqual({});
    // Planning may still see it.
    expect(memberPlanningPreferences(projection, "m-bob"))
      .toEqual({ trip_pace: "relaxed" });
  });

  it("lets a team-visible this-trip override replace the member's standing preference", () => {
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["trip_pace"], [BOB]: ["trip_pace"] },
      preferenceFacts: [
        { userId: ALICE, fieldKey: "trip_pace", value: "relaxed" },
        { userId: BOB, fieldKey: "trip_pace", value: "packed" },
      ],
      tripFacts: [{
        ownerUserId: BOB, fieldKey: "trip_pace",
        kind: "PERSONAL_OVERRIDE", visibility: "TEAM_VISIBLE", valueJson: { value: "relaxed" },
      }],
    });
    expect(tripWidePreferences(projection)).toEqual({ trip_pace: "relaxed" });
  });

  it("does not synthesise a trip-wide value for a field that stays individual", () => {
    // `interests` is free text and marked not group-decidable. Two members
    // naming the same things in a different order mean the same preference and
    // are different data; matching them would be guessing at agreement, and a
    // consensus nobody reached is worse than none.
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["interests"], [BOB]: ["interests"] },
      preferenceFacts: [
        { userId: ALICE, fieldKey: "interests", value: ["food", "art"] },
        { userId: BOB, fieldKey: "interests", value: ["food", "art"] },
      ],
    });

    // Still visible per member, so planning can take their union.
    expect(projection.members["m-alice"].profileFacts).toEqual({ interests: ["food", "art"] });
    expect(tripWidePreferences(projection)).toEqual({});
  });

  it("compares only closed-enum fields, where equality is exact", () => {
    // Every group-decidable field is an enum or a boolean, so two members
    // expressing the same preference produce identical values and the
    // "different wording" problem cannot arise.
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["no_red_eye"], [BOB]: ["no_red_eye"] },
      preferenceFacts: [
        { userId: ALICE, fieldKey: "no_red_eye", value: true },
        { userId: BOB, fieldKey: "no_red_eye", value: true },
      ],
    });
    expect(tripWidePreferences(projection)).toEqual({ no_red_eye: true });
  });

  it("lets a group decision win over what members individually prefer", () => {
    const projection = build({
      consentedFieldsByUser: { [ALICE]: ["accommodation_style"], [BOB]: ["accommodation_style"] },
      preferenceFacts: [
        { userId: ALICE, fieldKey: "accommodation_style", value: "luxury" },
        { userId: BOB, fieldKey: "accommodation_style", value: "luxury" },
      ],
      tripFacts: [{
        ownerUserId: ALICE, fieldKey: "accommodation_style",
        kind: "GROUP_DECISION", visibility: "TEAM_VISIBLE", valueJson: { value: "budget" },
      }],
    });
    // The trip decided; that is not something an inference should overturn.
    expect(tripWidePreferences(projection)).toEqual({ accommodation_style: "budget" });
  });
});
