import { describe, expect, it } from "vitest";
import {
  coherentBriefDates,
  mergePendingBriefProposal,
  mergeTripBriefProposal,
  normalizeBriefDestinations,
  proposeTripBriefFromTurn,
} from "../src/services/trip-brief-proposal-service.js";

/** The day the reported turn happened, so the year rollover is pinned. */
const SEPTEMBER_2026 = new Date("2026-09-04T13:26:38Z");

describe("proposeTripBriefFromTurn", () => {
  it("extracts explicit English destination and duration", () => {
    expect(proposeTripBriefFromTurn("I am going to Tokyo for 7 days")).toEqual({ destinationCandidates: ["Tokyo"], travelDays: 7 });
  });
  it("uses a selected map place without retaining the question", () => {
    expect(proposeTripBriefFromTurn("7 days", { name: "Kyoto", latitude: 35, longitude: 135, sourceType: "REFERENCE" })).toEqual({ destinationCandidates: ["Kyoto"], travelDays: 7 });
  });
  it("does not create a candidate from unrelated text", () => {
    expect(proposeTripBriefFromTurn("What food should I try?")).toBeNull();
  });
  it("does not turn an English explanation request into an itinerary route", () => {
    expect(proposeTripBriefFromTurn("Introduce Shanghai to me")).toBeNull();
  });
  it("extracts an explicit Chinese departure city without treating it as a route plan", () => {
    expect(proposeTripBriefFromTurn("从上海走")).toEqual({ departureCities: ["上海"] });
  });
  it("extracts an explicit Chinese month/day as a reviewable trip date", () => {
    const proposal = proposeTripBriefFromTurn("我从上海出发，12月10号左右吧");
    expect(proposal).toMatchObject({ departureCities: ["上海"], travelDateStart: expect.stringMatching(/^\d{4}-12-10$/) });
  });
});

/**
 * The worked example from docs/personal-and-planning-boundaries.md §9, which
 * the extractor could not read: "三" is not a digit, so the duration was
 * invisible and the destination — which ends where the duration begins —
 * swallowed it whole, yielding "苏州玩三天". The departure needed a leading 从
 * that people often leave out.
 */
describe("the §9 acceptance sentence", () => {
  it("reads all four facts the confirmation card is supposed to show", () => {
    expect(proposeTripBriefFromTurn("上海出发，12月10日左右去苏州玩三天")).toEqual({
      departureCities: ["上海"],
      destinationCandidates: ["Suzhou"],
      travelDateStart: "2026-12-10",
      travelDays: 3,
    });
  });

  it("reads Chinese numerals as durations", () => {
    expect(proposeTripBriefFromTurn("去京都玩两天")?.travelDays).toBe(2);
    expect(proposeTripBriefFromTurn("去京都玩十天")?.travelDays).toBe(10);
    expect(proposeTripBriefFromTurn("去京都玩十五天")?.travelDays).toBe(15);
    expect(proposeTripBriefFromTurn("去京都玩三十天")?.travelDays).toBe(30);
  });

  it("leaves a numeral that is part of a place name alone", () => {
    // 三亚 must not become 3亚.
    expect(proposeTripBriefFromTurn("去三亚待十天")).toEqual({
      destinationCandidates: ["Sanya"],
      travelDays: 10,
    });
  });

  it("does not read a date fragment as a departure city", () => {
    // "就按 12 月 10 日出发" ends in 出发 as well; the bare form read the 日.
    expect(proposeTripBriefFromTurn("就按 12 月 10 日出发，一个人")).toEqual({
      travelDateStart: "2026-12-10",
    });
    expect(proposeTripBriefFromTurn("12月10日出发")?.departureCities).toBeUndefined();
  });

  it("accepts a departure city written without 从", () => {
    expect(proposeTripBriefFromTurn("上海出发去杭州")?.departureCities).toEqual(["上海"]);
    expect(proposeTripBriefFromTurn("从上海出发去杭州")?.departureCities).toEqual(["上海"]);
  });

  it("reads a route written without a verb, and an ISO date", () => {
    expect(proposeTripBriefFromTurn("Shanghai to Suzhou on 2026-12-10 for 3 days")).toEqual({
      departureCities: ["Shanghai"],
      destinationCandidates: ["Suzhou"],
      travelDateStart: "2026-12-10",
      travelDays: 3,
    });
  });

  it("does not mistake the words before a travel verb for a departure city", () => {
    const proposal = proposeTripBriefFromTurn("I want to go to Kyoto for 5 days");
    expect(proposal?.destinationCandidates).toEqual(["Kyoto"]);
    expect(proposal?.departureCities).toBeUndefined();
  });

  it("splits 从A去B when the duration is stated later in the sentence", () => {
    // The reported turn: the departure field showed the whole route and the
    // destination kept its 玩, because the departure pattern only stopped at
    // 走 or punctuation and the destination only shed 玩 when a duration
    // followed it immediately.
    expect(proposeTripBriefFromTurn("我想从新加坡去北京玩，帮我规划两人，15天的行程")).toEqual({
      departureCities: ["新加坡"],
      destinationCandidates: ["Beijing"],
      travelDays: 15,
    });
  });

  it("keeps reading 从A到B and 从A飞B as a route", () => {
    expect(proposeTripBriefFromTurn("从北京到成都")?.departureCities).toEqual(["北京"]);
    expect(proposeTripBriefFromTurn("从广州飞曼谷")?.departureCities).toEqual(["广州"]);
  });
});

describe("normalizeBriefDestinations", () => {
  it("writes canonical city names only", () => {
    expect(normalizeBriefDestinations(["上海"])).toEqual(["Shanghai"]);
  });

  it("fails closed for a pronoun or an unknown place", () => {
    expect(normalizeBriefDestinations(["me"])).toBeNull();
    expect(normalizeBriefDestinations(["Not a real city"])).toBeNull();
  });
});

describe("mergeTripBriefProposal", () => {
  it("keeps only scheduling facts from the model extraction", () => {
    expect(mergeTripBriefProposal(null, {
      departureCities: ["Forged departure"],
      destinationCandidates: ["Forged destination"],
      travelDateStart: "2026-12-10",
      travelDateEnd: "2026-12-14",
      travelDays: 5,
    })).toEqual({ travelDateStart: "2026-12-10", travelDateEnd: "2026-12-14", travelDays: 5 });
  });

  it("gives an explicit owner statement precedence over model scheduling", () => {
    expect(mergeTripBriefProposal(
      { destinationCandidates: ["Shanghai"], travelDays: 3 },
      { travelDays: 5 },
    )).toEqual({ destinationCandidates: ["Shanghai"], travelDays: 3 });
  });

  /**
   * The reported failure. The owner wrote both ends of the range; this file
   * read the first and dated it 2026, the model supplied the second and dated
   * it 2024, and nothing compared them. The card that resulted answered 400
   * on every click, and refreshing could not help because the pair was stored
   * on the trip.
   */
  it("drops a model end date that lands before the parsed start", () => {
    expect(mergeTripBriefProposal(
      { destinationCandidates: ["Shanghai"], travelDateStart: "2026-10-01" },
      { travelDateEnd: "2024-10-07" },
      SEPTEMBER_2026,
    )).toEqual({ destinationCandidates: ["Shanghai"] });
  });

  it("keeps a model end date that agrees with the parsed start", () => {
    expect(mergeTripBriefProposal(
      { travelDateStart: "2026-10-01" },
      { travelDateEnd: "2026-10-07" },
      SEPTEMBER_2026,
    )).toEqual({ travelDateStart: "2026-10-01", travelDateEnd: "2026-10-07" });
  });
});

describe("the range the owner wrote themselves", () => {
  it("reads both ends of 10月1号到10月7号, in the year that is still ahead", () => {
    expect(proposeTripBriefFromTurn("我想要10月1号到10月7号去上海", undefined, SEPTEMBER_2026)).toEqual({
      destinationCandidates: ["Shanghai"],
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-07",
    });
  });

  it("carries the month across when the tail omits it", () => {
    expect(proposeTripBriefFromTurn("10月1号到7号去上海", undefined, SEPTEMBER_2026)).toMatchObject({
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-07",
    });
  });

  it("crosses into the next year when the range does", () => {
    expect(proposeTripBriefFromTurn("12月28号到1月3号去东京", undefined, SEPTEMBER_2026)).toMatchObject({
      travelDateStart: "2026-12-28",
      travelDateEnd: "2027-01-03",
    });
  });

  it("reads an English and an ISO range", () => {
    expect(proposeTripBriefFromTurn("Going to Kyoto October 1 to October 7", undefined, SEPTEMBER_2026)).toMatchObject({
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-07",
    });
    expect(proposeTripBriefFromTurn("2026-10-01 to 2026-10-07 in Kyoto", undefined, SEPTEMBER_2026)).toMatchObject({
      travelDateStart: "2026-10-01",
      travelDateEnd: "2026-10-07",
    });
  });

  it("keeps a lone date a lone date", () => {
    const proposal = proposeTripBriefFromTurn("12月10号去苏州", undefined, SEPTEMBER_2026);
    expect(proposal).toMatchObject({ travelDateStart: "2026-12-10" });
    expect(proposal?.travelDateEnd).toBeUndefined();
  });
});

describe("coherentBriefDates", () => {
  it("passes a pair that holds together", () => {
    const dates = { travelDateStart: "2026-10-01", travelDateEnd: "2026-10-07" };
    expect(coherentBriefDates(dates, SEPTEMBER_2026)).toEqual({ proposal: dates, result: "ok" });
  });

  it("keeps the destination when it drops the dates", () => {
    expect(coherentBriefDates(
      { destinationCandidates: ["Shanghai"], travelDateStart: "2026-10-01", travelDateEnd: "2024-10-07" },
      SEPTEMBER_2026,
    )).toEqual({ proposal: { destinationCandidates: ["Shanghai"] }, result: "end_before_start" });
  });

  /**
   * The other half of the same fault: this pair is internally consistent, so
   * the write boundary accepted it and the trip was silently given travel
   * dates two years in the past, titled 行程规划｜1天.
   */
  it("drops a pair that has already happened", () => {
    expect(coherentBriefDates(
      { travelDateStart: "2024-10-01", travelDateEnd: "2024-10-01" },
      SEPTEMBER_2026,
    )).toEqual({ proposal: {}, result: "in_past" });
  });

  it("drops a date that is not a date", () => {
    expect(coherentBriefDates({ travelDateStart: "2026-02-30" }, SEPTEMBER_2026).result).toBe("malformed");
  });

  it("leaves a proposal with no dates alone", () => {
    const proposal = { destinationCandidates: ["Shanghai"], travelDays: 3 };
    expect(coherentBriefDates(proposal, SEPTEMBER_2026)).toEqual({ proposal, result: "ok" });
  });
});

describe("mergePendingBriefProposal", () => {
  it("folds a later turn into the proposal the trip is carrying", () => {
    expect(mergePendingBriefProposal(
      { destinationCandidates: ["Shanghai"] },
      { travelDateStart: "2026-10-01", travelDateEnd: "2026-10-07" },
      SEPTEMBER_2026,
    )).toEqual({
      proposal: { destinationCandidates: ["Shanghai"], travelDateStart: "2026-10-01", travelDateEnd: "2026-10-07" },
      result: "ok",
    });
  });

  it("refuses a pair assembled across two turns that cannot be true", () => {
    // Neither turn was wrong on its own, which is exactly why the jsonb merge
    // this replaced could not catch it.
    expect(mergePendingBriefProposal(
      { destinationCandidates: ["Shanghai"], travelDateStart: "2026-10-01" },
      { travelDateEnd: "2024-10-07" },
      SEPTEMBER_2026,
    )).toEqual({ proposal: { destinationCandidates: ["Shanghai"] }, result: "end_before_start" });
  });

  it("clears the proposal when nothing survives", () => {
    expect(mergePendingBriefProposal(null, { travelDateStart: "2024-10-01" }, SEPTEMBER_2026))
      .toEqual({ proposal: null, result: "in_past" });
  });
});
