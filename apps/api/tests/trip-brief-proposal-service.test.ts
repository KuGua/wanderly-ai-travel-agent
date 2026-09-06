import { describe, expect, it } from "vitest";
import {
  coherentBriefDates,
  isBriefDestinationCountry,
  mergePendingBriefProposal,
  mergeTripBriefProposal,
  normalizeBriefDestinations,
  normalizeBriefProposalDepartures,
  normalizeBriefProposalDestinations,
  proposeTripBriefFromTurn,
  withoutDestinationCandidates,
  withoutImplicitDeparture,
  withoutSettledFields,
} from "../src/services/trip-brief-proposal-service.js";

/** The day the reported turn happened, so the year rollover is pinned. */
const SEPTEMBER_2026 = new Date("2026-09-04T13:26:38Z");

describe("proposeTripBriefFromTurn", () => {
  it("does not turn a bare city detail request into trip brief state", () => {
    expect(proposeTripBriefFromTurn("北京")).toBeNull();
    expect(proposeTripBriefFromTurn("上海")).toBeNull();
  });

  it("extracts explicit English destination and duration", () => {
    expect(proposeTripBriefFromTurn("I am going to Tokyo for 7 days")).toEqual({ destinationCandidates: ["Tokyo"], travelDays: 7 });
  });
  it("uses a selected map place without retaining the question", () => {
    expect(proposeTripBriefFromTurn("7 days", { name: "Kyoto", latitude: 35, longitude: 135, sourceType: "REFERENCE" })).toEqual({ destinationCandidates: ["Kyoto"], travelDays: 7 });
  });
  it("does not turn a selected country into a destination confirmation", () => {
    expect(proposeTripBriefFromTurn("法国", {
      name: "法国", latitude: 46.2, longitude: 2.2, sourceType: "REFERENCE",
    })).toBeNull();
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
  it.each([
    "出发地改为北京",
    "把出发地改为北京",
    "出发城市设置为北京",
    "改从北京走",
  ])("extracts an explicit origin-field update: %s", (question) => {
    expect(proposeTripBriefFromTurn(question)).toEqual({ departureCities: ["北京"] });
  });
  it("extracts an explicit Chinese month/day as a reviewable trip date", () => {
    const proposal = proposeTripBriefFromTurn("我从上海出发，12月10号左右吧");
    expect(proposal).toMatchObject({ departureCities: ["上海"], travelDateStart: expect.stringMatching(/^\d{4}-12-10$/) });
  });
});

describe("withoutImplicitDeparture", () => {
  it("drops a model-supplied origin for a bare city detail request", () => {
    expect(withoutImplicitDeparture({ departureCities: ["上海"] }, "上海")).toBeUndefined();
  });

  it("keeps an origin only when the owner explicitly states the departure", () => {
    expect(withoutImplicitDeparture({ departureCities: ["北京"], travelDays: 3 }, "从上海出发，玩三天"))
      .toEqual({ departureCities: ["Shanghai"], travelDays: 3 });
  });

  /**
   * This runs after `normalizeBriefProposalDepartures`, so returning the raw
   * owner text used to undo the resolver: the card carried 北京 while an
   * accepted trip row carried Beijing, and `withoutSettledFields` compares the
   * two — the origin card reopened on every later turn that named it.
   */
  it("canonicalizes the owner's own wording instead of undoing the resolver", () => {
    expect(withoutImplicitDeparture({ departureCities: ["Beijing"] }, "出发地改为北京"))
      .toEqual({ departureCities: ["Beijing"] });
  });

  it("drops an origin the catalogue cannot name without taking the dates", () => {
    expect(withoutImplicitDeparture({ departureCities: ["Beijing"], travelDays: 3 }, "从瓦坎达出发，玩三天"))
      .toEqual({ travelDays: 3 });
  });

  it("leaves a bare city with no generic brief fields at the final card boundary", () => {
    const candidate = withoutDestinationCandidates({
      departureCities: ["上海"],
      destinationCandidates: ["Shanghai"],
    });
    expect(withoutImplicitDeparture(candidate, "上海")).toBeUndefined();
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

  it("drops an entire confirmation proposal when its destination is not a city", () => {
    expect(normalizeBriefProposalDestinations({
      destinationCandidates: ["France"], travelDays: 7,
    })).toBeNull();
  });

  it("classifies a known country as exploration context, not a city", () => {
    expect(isBriefDestinationCountry("France")).toBe(true);
    expect(isBriefDestinationCountry("Paris")).toBe(false);
  });
});

describe("normalizeBriefProposalDepartures", () => {
  it("canonicalizes an explicit origin before persistence", () => {
    expect(normalizeBriefProposalDepartures({ departureCities: ["北京"], travelDays: 3 }))
      .toEqual({ departureCities: ["Beijing"], travelDays: 3 });
  });

  it("fails closed for an unresolved origin", () => {
    expect(normalizeBriefProposalDepartures({ departureCities: ["Not a real city"] })).toBeNull();
  });

  it("drops only the unresolved origin, leaving the same turn's schedule", () => {
    expect(normalizeBriefProposalDepartures({ departureCities: ["Not a real city"], travelDays: 3 }))
      .toEqual({ travelDays: 3 });
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

  it("does not turn a place the assistant merely suggested into the destination", () => {
    // The reply that follows the preference card offers example directions —
    // "Seoul or Osaka, or Bangkok if you want it slower". None of those is a
    // decision, and none may raise the confirmation card. Only what the
    // traveller typed or pinned can.
    expect(mergeTripBriefProposal(null, { destinationCandidates: ["Bangkok", "Chiang Mai"] }))
      .toBeUndefined();
    expect(mergeTripBriefProposal(
      { departureCities: ["Chengdu"] },
      { destinationCandidates: ["Bangkok"] },
    )).toEqual({ departureCities: ["Chengdu"] });
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

/**
 * The review card is raised by the existence of a proposal, and the extractor
 * fires on any one of departure, destination, dates or duration. A turn that
 * merely repeats a settled fact therefore put the card back on screen — a
 * traveller who had saved Gero and a 10-day length was asked
 * 「你想将这里作为目的地吗？」 again, with no destination in the proposal for the
 * question to even name, because the turn mentioned "10天" a second time.
 */
describe("withoutSettledFields", () => {
  // Canonical, because that is what the draft-brief write boundary stores.
  const settled = {
    departureCities: ["Beijing"],
    destinationCandidates: ["Gero"],
    travelDateStart: "2026-03-20",
    travelDateEnd: "2026-03-29",
    travelDays: 10,
  };

  it("drops a proposal that repeats what the trip already holds", () => {
    expect(withoutSettledFields({ travelDays: 10 }, settled)).toBeNull();
    expect(withoutSettledFields({ destinationCandidates: ["Gero"] }, settled)).toBeNull();
    expect(withoutSettledFields({ departureCities: ["Beijing"], travelDays: 10 }, settled)).toBeNull();
  });

  it("ignores case when comparing place names", () => {
    expect(withoutSettledFields({ destinationCandidates: ["gero"] }, settled)).toBeNull();
  });

  it("keeps a genuinely new destination", () => {
    expect(withoutSettledFields({ destinationCandidates: ["京都"], travelDays: 10 }, settled))
      .toEqual({ destinationCandidates: ["京都"] });
  });

  it("keeps a new field while dropping the settled ones beside it", () => {
    expect(withoutSettledFields({ travelDateStart: "2026-04-01", travelDays: 10 }, settled))
      .toEqual({ travelDateStart: "2026-04-01" });
  });

  it("treats a different candidate set as new even when it contains the settled one", () => {
    expect(withoutSettledFields({ destinationCandidates: ["Gero", "京都"] }, settled))
      .toEqual({ destinationCandidates: ["Gero", "京都"] });
  });

  it("passes a null proposal through", () => {
    expect(withoutSettledFields(null, settled)).toBeNull();
  });

  it("keeps everything when the trip has settled nothing", () => {
    const empty = {
      departureCities: [], destinationCandidates: [],
      travelDateStart: null, travelDateEnd: null, travelDays: null,
    };
    expect(withoutSettledFields({ destinationCandidates: ["Gero"], travelDays: 10 }, empty))
      .toEqual({ destinationCandidates: ["Gero"], travelDays: 10 });
  });
});

/**
 * "9月27号出发，10月2号回程" — the way people actually say a round trip. Only
 * the connector form ("从9月27日到10月2日") was covered, so this whole family
 * produced a start date and dropped the return, and the confirmation card
 * offered a single date under a 往返日期 label.
 */
describe("a range stated by departure and return roles", () => {
  const now = new Date("2026-09-06T12:00:00Z");

  it.each([
    ["九月27出发，10月一号回程", "2026-09-27", "2026-10-01"],
    ["九月27出发，10月二号回程", "2026-09-27", "2026-10-02"],
    ["9月27日出发，10月1日回程", "2026-09-27", "2026-10-01"],
    ["9月27号出发，10月2号回来", "2026-09-27", "2026-10-02"],
    ["我们9月27号飞，10月2号回", "2026-09-27", "2026-10-02"],
  ])("reads both ends of %s", (question, start, end) => {
    expect(proposeTripBriefFromTurn(question, undefined, now))
      .toMatchObject({ travelDateStart: start, travelDateEnd: end });
  });

  it("carries the return into the next year when it falls before the departure", () => {
    expect(proposeTripBriefFromTurn("12月28号出发，1月3号返程", undefined, now))
      .toMatchObject({ travelDateStart: "2026-12-28", travelDateEnd: "2027-01-03" });
  });

  it("needs a real second date, not merely a return word", () => {
    expect(proposeTripBriefFromTurn("9月27号出发", undefined, now))
      .toEqual({ travelDateStart: "2026-09-27" });
    // "玩三天后回" is a duration, and reading its 三 as a return day would put
    // the trip back on the 3rd of the same month.
    expect(proposeTripBriefFromTurn("10月1日出发，玩三天后回", undefined, now))
      .toEqual({ travelDateStart: "2026-10-01", travelDays: 3 });
  });

  it("still prefers an explicit connector range", () => {
    expect(proposeTripBriefFromTurn("10月1日到10月5日", undefined, now))
      .toMatchObject({ travelDateStart: "2026-10-01", travelDateEnd: "2026-10-05" });
  });

  it.each([
    ["2026.12.4-12.10", "2026-12-04", "2026-12-10"],
    ["2026/12/4-12/10", "2026-12-04", "2026-12-10"],
    ["2026.12.28-2027.1.3", "2026-12-28", "2027-01-03"],
  ])("reads compact numeric date ranges: %s", (question, start, end) => {
    expect(proposeTripBriefFromTurn(question, undefined, now))
      .toMatchObject({ travelDateStart: start, travelDateEnd: end });
  });
});

/**
 * The worker's origin path end to end, in the order it actually runs:
 * parse the owner turn → canonicalize → strip destination → re-derive the
 * departure from the owner's own words → subtract what the trip already holds.
 *
 * Each step was individually correct while the sequence was not, so this
 * covers §3.3 of docs/cue-and-brief-trigger-remediation-plan.md ("同一字段已
 * 等于 Trip 当前值时不再弹卡") at the seam rather than in the parts.
 */
describe("origin proposal pipeline", () => {
  const noSettledBrief = {
    departureCities: [] as string[],
    destinationCandidates: [] as string[],
    travelDateStart: null,
    travelDateEnd: null,
    travelDays: null,
  };

  function pipeline(question: string) {
    const direct = proposeTripBriefFromTurn(question);
    const normalized = direct ? normalizeBriefProposalDepartures(direct) : null;
    return withoutImplicitDeparture(withoutDestinationCandidates(normalized), question) ?? null;
  }

  it("carries the canonical city all the way to the card", () => {
    expect(pipeline("出发地改为北京")).toEqual({ departureCities: ["Beijing"] });
    expect(pipeline("改从北京走")).toEqual({ departureCities: ["Beijing"] });
  });

  it("stops asking once the trip already holds that origin", () => {
    const settled = { ...noSettledBrief, departureCities: ["Beijing"] };
    expect(withoutSettledFields(pipeline("出发地改为北京"), settled)).toBeNull();
  });

  it("keeps origin, destination and duration in their own scopes", () => {
    expect(pipeline("从北京去上海，玩三天")).toEqual({ departureCities: ["Beijing"], travelDays: 3 });
  });

  it("loses only the unresolvable origin, never the duration beside it", () => {
    expect(pipeline("从瓦坎达去上海，玩三天")).toEqual({ travelDays: 3 });
  });
});
