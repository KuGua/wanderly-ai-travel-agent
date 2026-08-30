import { describe, expect, it } from "vitest";

import {
  MEMORY_FIELD_CATALOG,
  consentExportableFieldKeys,
  isRegisteredMemoryField,
  memoryFieldDefinition,
  validateMemoryFieldValue,
} from "../src/memory/memory-field-catalog.js";

const SENSITIVE_KEYS = ["nationality", "date_of_birth", "mobility_notes"];

describe("catalogue registration", () => {
  it("fails closed on an unregistered field", () => {
    expect(isRegisteredMemoryField("favourite_colour")).toBe(false);
    expect(memoryFieldDefinition("favourite_colour")).toBeNull();
    expect(validateMemoryFieldValue("favourite_colour", "blue", "PROFILE_FORM"))
      .toEqual({ ok: false, reason: "UNREGISTERED_FIELD" });
  });

  it("classifies every registered field", () => {
    for (const definition of Object.values(MEMORY_FIELD_CATALOG)) {
      expect(definition.category).toMatch(/^(PREFERENCE|CONSTRAINT)$/);
      expect(definition.sensitivity).toMatch(/^(STANDARD|FORM_ONLY)$/);
    }
  });
});

describe("sensitive fields are form-only", () => {
  it.each(SENSITIVE_KEYS)("%s is never proposable or exportable", (key) => {
    const definition = memoryFieldDefinition(key);
    expect(definition?.sensitivity).toBe("FORM_ONLY");
    expect(definition?.proposable).toBe(false);
    expect(definition?.consentExportable).toBe(false);
    expect(definition?.tripOverridable).toBe(false);
    expect(definition?.groupDecidable).toBe(false);
  });

  it.each(SENSITIVE_KEYS)("%s is refused on every non-form write path", (key) => {
    for (const path of ["PROPOSAL_CONFIRMATION", "BEHAVIOR_AGGREGATION", "OWNER_SAVE", "GROUP_COMMAND"] as const) {
      expect(validateMemoryFieldValue(key, "anything", path))
        .toEqual({ ok: false, reason: "SENSITIVE_FIELD" });
    }
  });

  it("accepts a sensitive field only from the profile form", () => {
    const result = validateMemoryFieldValue("nationality", "Singapore", "PROFILE_FORM");
    expect(result.ok).toBe(true);
  });

  it("keeps sensitive keys out of the consent-exportable set", () => {
    const exportable = consentExportableFieldKeys();
    for (const key of SENSITIVE_KEYS) expect(exportable).not.toContain(key);
  });
});

describe("value schemas", () => {
  it("accepts a valid value and returns the parsed form", () => {
    const result = validateMemoryFieldValue("accommodation_style", "budget", "PROFILE_FORM");
    expect(result).toMatchObject({ ok: true, value: "budget" });
  });

  it("rejects a value outside the field's schema", () => {
    expect(validateMemoryFieldValue("accommodation_style", "castle", "PROFILE_FORM"))
      .toEqual({ ok: false, reason: "INVALID_VALUE" });
    expect(validateMemoryFieldValue("no_red_eye", "yes", "PROFILE_FORM"))
      .toEqual({ ok: false, reason: "INVALID_VALUE" });
    expect(validateMemoryFieldValue("budget_max_usd", -5, "PROFILE_FORM"))
      .toEqual({ ok: false, reason: "INVALID_VALUE" });
  });

  it("refuses behavioural proposals for fields that are decisions, not habits", () => {
    // A budget is stated, never inferred.
    expect(validateMemoryFieldValue("budget_max_usd", 2000, "BEHAVIOR_AGGREGATION"))
      .toEqual({ ok: false, reason: "SENSITIVE_FIELD" });
  });

  it("refuses a group decision on a field that is personal only", () => {
    expect(validateMemoryFieldValue("interests", ["art"], "GROUP_COMMAND"))
      .toEqual({ ok: false, reason: "SENSITIVE_FIELD" });
  });
});
