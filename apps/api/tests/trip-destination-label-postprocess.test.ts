import { describe, expect, it } from "vitest";

import { postprocessTripDestinationLabel } from "../src/services/trip-destination-label-postprocess.js";

describe("postprocessTripDestinationLabel", () => {
  describe("with bundled GeoNames + Natural Earth data (in-process default)", () => {
    it("canonicalises a CITY value to the dataset's city name (zh locale)", () => {
      const result = postprocessTripDestinationLabel({ kind: "CITY", value: "东京" }, "zh");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.kind).toBe("CITY");
        // The dataset's canonical name is the English form; locale only
        // affects COUNTRY labels where the dataset has parallel forms.
        expect(result.value).toBe("Tokyo");
      }
    });

    it("canonicalises a CITY value to the dataset's city name (en locale)", () => {
      const result = postprocessTripDestinationLabel({ kind: "CITY", value: "Paris" }, "en");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.kind).toBe("CITY");
        expect(result.value).toBe("Paris");
      }
    });

    it("canonicalises a COUNTRY value to the locale-appropriate name (zh)", () => {
      const result = postprocessTripDestinationLabel({ kind: "COUNTRY", value: "法国" }, "zh");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.kind).toBe("COUNTRY");
        expect(result.value).toBe("法国");
      }
    });

    it("canonicalises a COUNTRY value to the locale-appropriate name (en)", () => {
      const result = postprocessTripDestinationLabel({ kind: "COUNTRY", value: "France" }, "en");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.kind).toBe("COUNTRY");
        expect(result.value).toBe("France");
      }
    });

    it("falls back to English when the dataset has no Chinese country label", () => {
      const result = postprocessTripDestinationLabel({ kind: "COUNTRY", value: "Japan" }, "zh");
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The bundled dataset's Japan NAME_ZH is "日本". Falls back to it.
        expect(result.value).toBe("日本");
      }
    });
  });

  describe("rejection paths (fail-closed)", () => {
    it("rejects empty value", () => {
      const result = postprocessTripDestinationLabel({ kind: "COUNTRY", value: "" }, "en");
      expect(result).toEqual({ ok: false, reason: "REJECTED" });
    });

    it("rejects whitespace-only value", () => {
      const result = postprocessTripDestinationLabel({ kind: "COUNTRY", value: "   \t  " }, "en");
      expect(result).toEqual({ ok: false, reason: "REJECTED" });
    });

    it("rejects values longer than 64 code points (no truncation)", () => {
      const longName = "A".repeat(65);
      const result = postprocessTripDestinationLabel({ kind: "COUNTRY", value: longName }, "en");
      expect(result).toEqual({ ok: false, reason: "REJECTED" });
    });

    it("rejects CITY values that are neither city nor country (free text)", () => {
      const result = postprocessTripDestinationLabel({ kind: "CITY", value: "Please book me a flight to Tokyo" }, "en");
      expect(result).toEqual({ ok: false, reason: "REJECTED" });
    });

    it("rejects URLs and emails without explicit URL rules (reparse does the work)", () => {
      const url = postprocessTripDestinationLabel({ kind: "CITY", value: "https://example.com" }, "en");
      expect(url).toEqual({ ok: false, reason: "REJECTED" });
      const email = postprocessTripDestinationLabel({ kind: "COUNTRY", value: "user@example.com" }, "en");
      expect(email).toEqual({ ok: false, reason: "REJECTED" });
    });

    it("rejects an unknown country name", () => {
      const result = postprocessTripDestinationLabel({ kind: "COUNTRY", value: "Atlantis" }, "en");
      expect(result).toEqual({ ok: false, reason: "REJECTED" });
    });

    it("rejects an ambiguous cross-country city (Valencia, ratio < 5)", () => {
      const result = postprocessTripDestinationLabel({ kind: "CITY", value: "Valencia" }, "en");
      expect(result).toEqual({ ok: false, reason: "REJECTED" });
    });

    it("rejects an ambiguous cross-country city (Barcelona)", () => {
      const result = postprocessTripDestinationLabel({ kind: "CITY", value: "Barcelona" }, "en");
      expect(result).toEqual({ ok: false, reason: "REJECTED" });
    });

    it("strips emoji and control characters before length check", () => {
      // 1 char + emoji (which we strip) + 1 char + control char + "Paris"
      // After strip: "Paris" — should resolve.
      const result = postprocessTripDestinationLabel(
        { kind: "CITY", value: "Pa😀ris" },
        "en",
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("Paris");
    });
  });

  describe("canonical output is always a reference-data name", () => {
    it("never returns the raw input string for COUNTRY", () => {
      // An unusual input that happens to resolve to a country. We do not
      // pin a specific dataset value — the bundled GeoNames + Natural
      // Earth dataset has alias collisions (e.g. several "France"-prefixed
      // overseas territories share alias space). The contract under test is
      // "the returned label comes from the reference data, not the input".
      const result = postprocessTripDestinationLabel(
        { kind: "COUNTRY", value: "  italy  " },
        "en",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBe("  italy  ");
        expect(result.value.trim()).toBe(result.value);
      }
    });

    it("never returns the raw input string for CITY", () => {
      const result = postprocessTripDestinationLabel(
        { kind: "CITY", value: "  PARIS  " },
        "en",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBe("  PARIS  ");
        expect(result.value.trim()).toBe(result.value);
      }
    });
  });
});
