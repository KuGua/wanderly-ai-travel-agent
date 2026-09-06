import { describe, expect, it } from "vitest";

import { QUOTE_NATIONALITIES, countryLabel, isQuoteNationality } from "./nationality";

describe("countryLabel", () => {
  it("names the country, which is what the field asks for", () => {
    // The field is labelled Nation, not Nationality: it takes the country a
    // hotel quote is priced against, and "Singapore" is the right answer to it.
    expect(countryLabel("SG", "en")).toBe("Singapore");
    expect(countryLabel("CN", "en")).toBe("China");
    expect(countryLabel("SG", "zh")).toBe("新加坡");
  });

  it("covers the whole list, so no option falls back to a bare code", () => {
    for (const code of QUOTE_NATIONALITIES) {
      expect(countryLabel(code, "en")).not.toBe(code);
      expect(countryLabel(code, "zh")).not.toBe(code);
    }
  });

  it("keeps the territory notation the product fixed by hand", () => {
    expect(countryLabel("HK", "en")).toBe("Hong Kong (China)");
    expect(countryLabel("TW", "zh")).toBe("台湾（中国）");
  });

  it("still answers for a value outside the list", () => {
    expect(isQuoteNationality("ZZ")).toBe(false);
    expect(countryLabel("ZZ", "en")).toBeTruthy();
  });
});
