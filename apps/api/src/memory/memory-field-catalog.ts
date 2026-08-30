import { z } from "zod";

/**
 * MEMORY_FIELD_CATALOG — the single registry of every field long-term memory
 * may hold, per docs/long-term-memory-implementation.md §4.4.
 *
 * Nothing outside this catalog can be stored as a preference fact, proposed by
 * behaviour aggregation, or exported into a snapshot projection. Lookups fail
 * closed: an unregistered key is rejected rather than passed through, which is
 * the schema-drift control in §9.
 */

export type MemoryFieldCategory = "PREFERENCE" | "CONSTRAINT";

/**
 * `FORM_ONLY` fields are the sensitive set in §1.1 decision 5 — nationality,
 * travel documents, date of birth, health and accessibility. They may only be
 * written by the owner's own Profile form. No conversation, model output or
 * behavioural path may ever create or propose them.
 */
export type MemoryFieldSensitivity = "STANDARD" | "FORM_ONLY";

export type MemoryFieldDefinition = {
  /** Stable storage key. */
  readonly key: string;
  readonly category: MemoryFieldCategory;
  readonly sensitivity: MemoryFieldSensitivity;
  /** Value shape. Anything failing this schema is rejected before storage. */
  readonly schema: z.ZodTypeAny;
  /** Whether BehaviorAggregationService may raise a proposal for this field. */
  readonly proposable: boolean;
  /** Whether the field may ever reach a shared snapshot under consent. */
  readonly consentExportable: boolean;
  /** Whether a member may override it for a single trip. */
  readonly tripOverridable: boolean;
  /** Whether it may be stored as a whole-group decision. */
  readonly groupDecidable: boolean;
};

const accommodationStyle = z.enum(["city_center", "budget", "luxury"]);
const tripPace = z.enum(["relaxed", "balanced", "packed"]);

function define(definition: MemoryFieldDefinition): MemoryFieldDefinition {
  return Object.freeze(definition);
}

/**
 * The MVP catalogue. Sensitive fields are registered deliberately — listing
 * them with `proposable: false` and `consentExportable: false` is what lets the
 * deny path be asserted in tests, rather than relying on their absence.
 */
export const MEMORY_FIELD_CATALOG: Readonly<Record<string, MemoryFieldDefinition>> = Object.freeze({
  accommodation_style: define({
    key: "accommodation_style",
    category: "PREFERENCE",
    sensitivity: "STANDARD",
    schema: accommodationStyle,
    proposable: true,
    consentExportable: true,
    tripOverridable: true,
    groupDecidable: true,
  }),
  no_red_eye: define({
    key: "no_red_eye",
    category: "CONSTRAINT",
    sensitivity: "STANDARD",
    schema: z.boolean(),
    proposable: true,
    consentExportable: true,
    tripOverridable: true,
    groupDecidable: true,
  }),
  interests: define({
    key: "interests",
    category: "PREFERENCE",
    sensitivity: "STANDARD",
    schema: z.array(z.string().trim().min(1).max(64)).max(20),
    proposable: true,
    consentExportable: true,
    tripOverridable: true,
    groupDecidable: false,
  }),
  trip_pace: define({
    key: "trip_pace",
    category: "PREFERENCE",
    sensitivity: "STANDARD",
    schema: tripPace,
    proposable: true,
    consentExportable: true,
    tripOverridable: true,
    groupDecidable: true,
  }),
  budget_max_usd: define({
    key: "budget_max_usd",
    category: "CONSTRAINT",
    sensitivity: "STANDARD",
    schema: z.number().int().nonnegative().max(1_000_000),
    // A budget is a decision, not a habit to infer from behaviour.
    proposable: false,
    consentExportable: true,
    tripOverridable: true,
    groupDecidable: false,
  }),
  departure_city: define({
    key: "departure_city",
    category: "CONSTRAINT",
    sensitivity: "STANDARD",
    schema: z.string().trim().min(1).max(64),
    proposable: false,
    consentExportable: true,
    tripOverridable: true,
    groupDecidable: false,
  }),

  // ─── Form-only sensitive fields ───────────────────────────────────────────
  // Registered so the deny path is explicit and testable. Never proposable,
  // never exportable, never trip-scoped.
  nationality: define({
    key: "nationality",
    category: "CONSTRAINT",
    sensitivity: "FORM_ONLY",
    schema: z.string().trim().min(1).max(64),
    proposable: false,
    consentExportable: false,
    tripOverridable: false,
    groupDecidable: false,
  }),
  date_of_birth: define({
    key: "date_of_birth",
    category: "CONSTRAINT",
    sensitivity: "FORM_ONLY",
    schema: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    proposable: false,
    consentExportable: false,
    tripOverridable: false,
    groupDecidable: false,
  }),
  mobility_notes: define({
    key: "mobility_notes",
    category: "CONSTRAINT",
    sensitivity: "FORM_ONLY",
    schema: z.string().trim().max(512),
    proposable: false,
    consentExportable: false,
    tripOverridable: false,
    groupDecidable: false,
  }),
});

export type MemoryFieldKey = keyof typeof MEMORY_FIELD_CATALOG;

export function isRegisteredMemoryField(fieldKey: string): boolean {
  return Object.hasOwn(MEMORY_FIELD_CATALOG, fieldKey);
}

/** Returns the definition, or `null` for anything unregistered. Fails closed. */
export function memoryFieldDefinition(fieldKey: string): MemoryFieldDefinition | null {
  return isRegisteredMemoryField(fieldKey) ? MEMORY_FIELD_CATALOG[fieldKey] : null;
}

export type MemoryFieldValidation =
  | { ok: true; definition: MemoryFieldDefinition; value: unknown }
  | { ok: false; reason: "UNREGISTERED_FIELD" | "SENSITIVE_FIELD" | "INVALID_VALUE" };

export type MemoryWritePath =
  | "PROFILE_FORM"
  | "PROPOSAL_CONFIRMATION"
  | "BEHAVIOR_AGGREGATION"
  | "OWNER_SAVE"
  | "GROUP_COMMAND";

/**
 * Validates a value against the catalogue for a given write path.
 *
 * Sensitive fields are accepted only from `PROFILE_FORM`; every other path —
 * including anything reachable from a model — is refused before the value is
 * looked at, so a sensitive key can never be written by inference.
 */
export function validateMemoryFieldValue(
  fieldKey: string,
  value: unknown,
  path: MemoryWritePath,
): MemoryFieldValidation {
  const definition = memoryFieldDefinition(fieldKey);
  if (!definition) return { ok: false, reason: "UNREGISTERED_FIELD" };

  if (definition.sensitivity === "FORM_ONLY" && path !== "PROFILE_FORM") {
    return { ok: false, reason: "SENSITIVE_FIELD" };
  }
  if (path === "BEHAVIOR_AGGREGATION" && !definition.proposable) {
    return { ok: false, reason: "SENSITIVE_FIELD" };
  }
  if (path === "GROUP_COMMAND" && !definition.groupDecidable) {
    return { ok: false, reason: "SENSITIVE_FIELD" };
  }
  if (path === "OWNER_SAVE" && !definition.tripOverridable) {
    return { ok: false, reason: "SENSITIVE_FIELD" };
  }

  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "INVALID_VALUE" };
  return { ok: true, definition, value: parsed.data };
}

/** Field keys a consent projection may ever carry. */
export function consentExportableFieldKeys(): string[] {
  return Object.values(MEMORY_FIELD_CATALOG)
    .filter((definition) => definition.consentExportable)
    .map((definition) => definition.key);
}
