import { describe, expect, it } from "vitest";

import { QUOTE_NATIONALITIES, isQuoteNationality, nationalityLabel } from "./nationality";

describe("nationalityLabel", () => {
  it("names an English reader's nationality, not their country", () => {
    // "Nationality: Singapore" answers a question the field did not ask.
    expect(nationalityLabel("SG", "en")).toBe("Singaporean");
    expect(nationalityLabel("CN", "en")).toBe("Chinese");
    expect(nationalityLabel("GB", "en")).toBe("British");
    expect(nationalityLabel("AE", "en")).toBe("Emirati");
  });

  it("covers the whole list, so no option falls back to a bare code", () => {
    for (const code of QUOTE_NATIONALITIES) {
      const label = nationalityLabel(code, "en");
      expect(label).not.toBe(code);
      expect(label.length).toBeGreaterThan(2);
    }
  });

  it("keeps the country form in Chinese, where a 国籍 field takes one", () => {
    expect(nationalityLabel("SG", "zh")).toBe("新加坡");
    expect(nationalityLabel("HK", "zh")).toBe("香港（中国）");
    expect(nationalityLabel("TW", "zh")).toBe("台湾（中国）");
  });

  it("keeps the territory notation the product fixed by hand", () => {
    expect(nationalityLabel("HK", "en")).toBe("Hong Kong (China)");
    expect(nationalityLabel("TW", "en")).toBe("Taiwan (China)");
  });

  it("still answers for a value outside the list", () => {
    expect(isQuoteNationality("ZZ")).toBe(false);
    expect(nationalityLabel("ZZ", "en")).toBeTruthy();
  });
});
