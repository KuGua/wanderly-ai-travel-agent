import { describe, expect, it } from "vitest";
import { mergeTripBriefProposal, normalizeBriefDestinations, proposeTripBriefFromTurn } from "../src/services/trip-brief-proposal-service.js";

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
});
