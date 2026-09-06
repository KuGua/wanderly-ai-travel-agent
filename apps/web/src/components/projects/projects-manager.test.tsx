import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/render";
import { rememberRecentTrip } from "@/lib/trips/recent-trip";
import { ProjectsManager } from "./projects-manager";

const state = vi.hoisted(() => ({
  auth: { status: "SIGNED_IN", user: { username: "alice" } },
  query: { isSuccess: true, isError: false, isPending: false,
    data: { trips: [{ id: "kyoto", name: "Kyoto" }, { id: "paris", name: "Paris" }] }, refetch: vi.fn() },
  useTrips: vi.fn(),
}));
vi.mock("@/lib/auth/auth-provider", () => ({ useOptionalAuth: () => state.auth }));
vi.mock("@/lib/query/hooks", () => ({ useTrips: (options: unknown) => { state.useTrips(options); return state.query; } }));

beforeEach(() => {
  sessionStorage.clear();
  state.auth.status = "SIGNED_IN";
  state.auth.user.username = "alice";
  state.query.isSuccess = true;
  state.query.isError = false;
  state.query.isPending = false;
  state.query.data.trips = [{ id: "kyoto", name: "Kyoto" }, { id: "paris", name: "Paris" }];
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("record room", () => {
  it.each(["en", "zh"] as const)("links the globe to home in %s", (locale) => {
    renderWithIntl(<ProjectsManager />, { locale });
    expect(screen.getByRole("link", { name: locale === "zh" ? "点击地球仪，去探索" : "Explore with the globe" })).toHaveAttribute("href", "/home");
  });
  it("puts only the last opened project on the platter and other projects below", () => {
    rememberRecentTrip("alice", "paris");
    renderWithIntl(<ProjectsManager />);
    expect(screen.getByRole("link", { name: "Open trip: Paris" }).className).toContain("platter");
    expect(screen.getByRole("link", { name: "Open trip: Kyoto" }).className).toContain("sleeve");
    expect(screen.getByRole("link", { name: "Open trip: Paris" })).toHaveAttribute("href", "/trips/paris");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New trip" })).toBeInTheDocument();
  });
  it.each([null, "removed"])("does not invent a recent project for pointer %s", (recent) => {
    if (recent) rememberRecentTrip("alice", recent);
    renderWithIntl(<ProjectsManager />);
    expect(screen.getAllByRole("link", { name: /^Open trip:/ })).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: /^Open trip:/ })) expect(link.className).toContain("sleeve");
  });
  it("does not inherit another account's pointer", () => {
    rememberRecentTrip("bob", "paris");
    renderWithIntl(<ProjectsManager />);
    expect(screen.getByRole("link", { name: "Open trip: Paris" }).className).toContain("sleeve");
  });
  it("hides cached trips and disables fetching when signed out", () => {
    state.auth.status = "SIGNED_OUT";
    renderWithIntl(<ProjectsManager />);
    expect(state.useTrips).toHaveBeenCalledWith({ enabled: false });
    expect(screen.queryByText("Paris")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in to your record collection" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Explore with the globe" })).toHaveAttribute("href", "/home");
  });
  it("fails closed on query error and offers retry", () => {
    state.query.isError = true;
    state.query.isSuccess = false;
    renderWithIntl(<ProjectsManager />);
    expect(screen.queryByText("Paris")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(state.query.refetch).toHaveBeenCalledOnce();
  });
  it("shows a localized empty collection without fabricated records", () => {
    state.query.data.trips = [];
    renderWithIntl(<ProjectsManager />, { locale: "zh" });
    expect(screen.getByRole("link", { name: "去探索，收藏第一段旅程" })).toHaveAttribute("href", "/home");
  });
});
