import { describe, expect, it } from "vitest";

import { createTripThreadSchema } from "../../src/types/schemas.js";

/**
 * The body the workspace's "New thread" button actually sends.
 *
 * The schema is `.strict()`, so a field named differently on each side is not
 * ignored — it is rejected. Called `locale` on the server and `titleLocale` on
 * the client, the button answered 400 and appeared to do nothing at all.
 */
describe("createTripThreadSchema", () => {
  it("accepts what the client sends", () => {
    expect(createTripThreadSchema.parse({ titleLocale: "zh" })).toEqual({ titleLocale: "zh" });
    expect(createTripThreadSchema.parse({ titleLocale: "en" })).toEqual({ titleLocale: "en" });
  });

  it("still accepts an empty body — the server names an auto thread itself", () => {
    expect(createTripThreadSchema.parse({})).toEqual({});
  });

  it("keeps rejecting a field it does not know", () => {
    // The strictness is the point; it just has to agree with the client on
    // what the fields are called.
    expect(() => createTripThreadSchema.parse({ locale: "zh" })).toThrow();
  });
});
