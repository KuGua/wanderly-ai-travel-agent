import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { SoloPlanProposalCard } from "@/components/trips/personal-research/solo-plan-proposal-card";
import type { ListedPlan } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";

const plan: Pick<ListedPlan, "id" | "version" | "status" | "destination"> = {
  id: "00000000-0000-0000-0000-000000000001",
  version: 1,
  status: "PROPOSED",
  destination: "Tokyo",
};

describe("SoloPlanProposalCard", () => {
  it("renders the plan version, destination, and an enabled adopt button for PROPOSED plans", () => {
    const onAdopted = vi.fn();
    renderWithIntl(<SoloPlanProposalCard tripId="trip-1" plan={plan} onAdopted={onAdopted} />);
    expect(screen.getByTestId("solo-plan-proposal-card")).toHaveAttribute(
      "data-plan-id",
      plan.id,
    );
    expect(screen.getByText(/Solo 方案 v1 · Tokyo/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    const adopt = buttons.find((b) => b.textContent === "采纳此方案");
    expect(adopt).toBeDefined();
    expect(adopt).toBeEnabled();
  });

  it("disables the adopt button when the plan is no longer PROPOSED", () => {
    renderWithIntl(
      <SoloPlanProposalCard tripId="trip-1" plan={{ ...plan, status: "ACTIVE" }} />,
    );
    // The card renders with the plan status text and disables the adopt
    // button. The Button component applies `disabled:opacity-50` styling
    // and sets the `aria-disabled` / `disabled` attribute. We assert the
    // status text + that the adopt button is the one with disabled state.
    expect(screen.getByText(/状态：ACTIVE/)).toBeInTheDocument();
    const adopts = screen.getAllByRole("button", { name: /采纳此方案/ });
    const disabled = adopts.find((b) => b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true");
    expect(disabled).toBeDefined();
  });
});