import { describe, expect, it } from "vitest";

import {
  foldDestinationName,
  matchesSnapshotDestination,
} from "../src/services/destination-candidate-match.js";

describe("matchesSnapshotDestination", () => {
  it("accepts the apostrophe the model writes for the one the resolver stored", () => {
    // The exact pair from the failing run: the snapshot held U+2019 and the
    // model called hotel.search with U+0027, so the tool was refused on every
    // turn until the budget was gone.
    const stored = "Xi’an";
    const fromModel = "Xi'an";

    expect(stored).not.toBe(fromModel);
    expect(matchesSnapshotDestination([stored], fromModel)).toBe(true);
    expect(matchesSnapshotDestination([fromModel], stored)).toBe(true);
  });

  it("accepts the other apostrophe-like marks place names are written with", () => {
    for (const mark of ["‘", "’", "ʻ", "ʼ", "ʹ", "′"]) {
      expect(matchesSnapshotDestination([`Hawai${mark}i`], "Hawai'i")).toBe(true);
    }
  });

  it("leaves a candidate that needs no folding alone", () => {
    expect(matchesSnapshotDestination(["Tokyo", "西安"], "西安")).toBe(true);
    expect(foldDestinationName("Tokyo")).toBe("Tokyo");
  });

  it("does not fold case", () => {
    // Proper nouns from several producers share this column. Two candidates
    // differing only in case are more likely two records than one place.
    expect(matchesSnapshotDestination(["Tokyo"], "tokyo")).toBe(false);
  });

  it("does not transliterate", () => {
    // Both spellings are real values in this column. Treating them as equal
    // would let a tool search a destination the traveller never confirmed.
    expect(matchesSnapshotDestination(["旧金山"], "San Francisco")).toBe(false);
    expect(matchesSnapshotDestination(["San Francisco"], "旧金山")).toBe(false);
  });

  it("still refuses a destination that is not on the trip", () => {
    expect(matchesSnapshotDestination(["Xi’an"], "Beijing")).toBe(false);
    expect(matchesSnapshotDestination([], "Xi'an")).toBe(false);
  });

  it("ignores surrounding whitespace only", () => {
    expect(matchesSnapshotDestination(["Xi’an"], "  Xi'an  ")).toBe(true);
    expect(matchesSnapshotDestination(["Xi’an"], "Xi 'an")).toBe(false);
  });
});
