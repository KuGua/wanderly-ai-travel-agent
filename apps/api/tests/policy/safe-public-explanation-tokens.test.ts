import { describe, expect, it } from "vitest";

import { safePublicExplanationTokensFor } from "../../src/policy/constraint-field-catalog.js";

/**
 * Field keys reach this from `trip_constraint_facts`, which is not restricted
 * to this catalogue's vocabulary: the preference card writes memory-catalogue
 * keys into the same table, and the two catalogues disagree on two of them —
 * `budget_max_usd` here is `budget_max` there, `trip_pace` is `pace`.
 *
 * The caller used to cast that string to the catalogue's key type, so an
 * unlisted key indexed to `undefined` and reading a property off it threw.
 * That took `POST /trips/:tripId/activate` down for any trip whose owner had
 * saved a budget or a pace.
 */
describe("safePublicExplanationTokensFor", () => {
  it("returns the catalogue's tokens for a field it knows", () => {
    expect(safePublicExplanationTokensFor("accommodation_style").length).toBeGreaterThan(0);
  });

  it("returns nothing for a field it does not know, rather than throwing", () => {
    // The exact two the preference card produces, plus a shape that could
    // only come from stored data.
    for (const unknown of ["budget_max_usd", "trip_pace", "not_a_field_at_all", ""]) {
      expect(() => safePublicExplanationTokensFor(unknown)).not.toThrow();
      expect(safePublicExplanationTokensFor(unknown)).toEqual([]);
    }
  });
});
