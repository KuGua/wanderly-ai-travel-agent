import { describe, expect, it } from "vitest";
import {
  assertLocationIntroductionOutputSafe,
  locationIntroductionOutputSchema,
} from "./location-introduction-schema.js";

const VALID_EN = "Tokyo is a city of contrasts — glass towers over neon-lit backstreets, vending machines beside tiny shrines, and a rhythm that shifts from morning calm to midnight rush. Wander between neighborhoods rather than chase a checklist, and let the city reveal itself over coffee, ramen, and long subway rides.";
const VALID_ZH = "京都真正迷人的地方，是藏在清晨的小巷、町屋、庭院和季节变化里的安静节奏。这里适合放慢速度去走，喝一杯茶、吃一顿认真做出来的料理，再留一点时间给没有计划的散步。";

describe("locationIntroductionOutputSchema", () => {
  it("accepts a well-formed English introduction", () => {
    const parsed = locationIntroductionOutputSchema.parse({ content: VALID_EN });
    expect(parsed.content.length).toBeGreaterThan(60);
  });

  it("accepts a well-formed Chinese introduction", () => {
    const parsed = locationIntroductionOutputSchema.parse({ content: VALID_ZH });
    expect(parsed.content.length).toBeGreaterThan(60);
  });

  it("rejects content shorter than 60 chars", () => {
    expect(() => locationIntroductionOutputSchema.parse({ content: "too short" })).toThrow();
  });

  it("rejects content longer than 720 chars", () => {
    const long = "a".repeat(721);
    expect(() => locationIntroductionOutputSchema.parse({ content: long })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => locationIntroductionOutputSchema.parse({ content: VALID_EN, meta: {} })).toThrow();
  });
});

describe("assertLocationIntroductionOutputSafe", () => {
  it("passes a clean introduction", () => {
    const out = locationIntroductionOutputSchema.parse({ content: VALID_EN });
    expect(assertLocationIntroductionOutputSafe(out).content).toBe(out.content);
  });

  it.each([
    ["today", VALID_EN.replace(/contrasts/, "contrasts today")],
    ["currently", "Currently open to visitors, this city feels like a museum without walls."],
    ["最新", "这是最新开放的景点之一，值得一去。"],
    ["¥ symbol", "Tokyo costs about ¥4,500 per night on average."],
    ["degree", "Expect 18°C mornings and bright afternoons in this place."],
  ])("rejects forbidden content (%s)", (_label, content) => {
    const out = locationIntroductionOutputSchema.parse({ content });
    expect(() => assertLocationIntroductionOutputSafe(out)).toThrow();
  });
});