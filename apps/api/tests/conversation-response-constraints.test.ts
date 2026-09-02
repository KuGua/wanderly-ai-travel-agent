import { describe, expect, it } from "vitest";

import { selectResponseConstraints } from "../src/tasks/handlers/conversation-task-handler.js";

const BOTH_TOOLS = ["hotel.search", "flight.search"] as const;

function select(overrides: Partial<Parameters<typeof selectResponseConstraints>[0]> = {}) {
  return selectResponseConstraints({
    tripStatus: "DRAFT",
    registeredTools: BOTH_TOOLS,
    hotelSearchStateExists: false,
    flightSearchStateExists: false,
    userConfirmed: false,
    confirmedCapability: null,
    ...overrides,
  });
}

describe("which search-readiness contracts a turn carries", () => {
  it("carries none while a DRAFT traveller is still describing the trip", () => {
    // The regression this exists for: "我想要带我女朋友国庆节的时候去新加坡玩4天"
    // is a planning statement, not a request to shop. Both contracts used to
    // be injected unconditionally — ~3.6k characters of "必须调用
    // hotel.search", six times the base prompt's planning-priority text and
    // last in the prompt — so the assistant spent four turns collecting IATA
    // codes, room counts and a currency, dispatched both tools speculatively,
    // and ended on two search-confirmation buttons. The trip brief never
    // received its dates, so the trip could not be activated at all.
    expect(select()).toEqual([]);
  });

  it("brings a contract back once that capability has persisted state", () => {
    // The traveller engaged this search on an earlier turn, so the follow-up
    // ("能不能换成 10 号入住") needs the full contract to be answerable.
    expect(select({ hotelSearchStateExists: true })).toEqual(["HOTEL_SEARCH_READINESS"]);
  });

  it("brings a contract in on the turn the traveller confirms that search", () => {
    expect(select({ userConfirmed: true, confirmedCapability: "flight.search" }))
      .toEqual(["FLIGHT_SEARCH_READINESS"]);
  });

  it("keeps one capability's state from speaking for the other", () => {
    // A flight readiness state is not a reason to start driving the traveller
    // toward a hotel search they never asked about.
    expect(select({ flightSearchStateExists: true })).toEqual(["FLIGHT_SEARCH_READINESS"]);
  });

  it("lets an unnamed confirmation reach both, as it always has", () => {
    expect(select({ userConfirmed: true, confirmedCapability: null }))
      .toEqual(["HOTEL_SEARCH_READINESS", "FLIGHT_SEARCH_READINESS"]);
  });

  it("leaves every status past DRAFT exactly as it was", () => {
    // Outside DRAFT the brief is already settled and handed to planning, so
    // this change deliberately alters nothing.
    for (const tripStatus of ["PLANNING", "STALE", "CONFIRMED", "BOOKED", "CANCELLED"] as const) {
      expect(select({ tripStatus }), tripStatus)
        .toEqual(["HOTEL_SEARCH_READINESS", "FLIGHT_SEARCH_READINESS"]);
    }
  });

  it("never sends a contract for a tool the turn does not carry", () => {
    // Nearly all of each block instructs the model to call its tool. Sent
    // without the tool it is an instruction that cannot be carried out.
    expect(select({ tripStatus: "PLANNING", registeredTools: ["hotel.search"] }))
      .toEqual(["HOTEL_SEARCH_READINESS"]);
    expect(select({ tripStatus: "PLANNING", registeredTools: [] })).toEqual([]);
    expect(select({ registeredTools: [], userConfirmed: true, confirmedCapability: null }))
      .toEqual([]);
  });

  it("does not gate the tools themselves, only the prompt", () => {
    // docs/draft-personal-research-implementation.md §1: a query the owner
    // explicitly asked for must not be blocked for being "not fully planned
    // yet". The tools stay registered in DRAFT — this helper only decides
    // what the system prompt says about them — so a traveller who does ask
    // still gets a search under the base prompt's own priority 2.
    const registeredTools = [...BOTH_TOOLS];
    select({ registeredTools });
    expect(registeredTools).toEqual(["hotel.search", "flight.search"]);
  });
});
