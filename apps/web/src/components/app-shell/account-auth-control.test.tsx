import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthContext } from "@/lib/auth/auth-provider";
import { renderWithIntl } from "@/test/render";

import { AccountAuthControl } from "./account-auth-control";

const signedInAuth = {
  status: "SIGNED_IN" as const,
  user: { username: "Epillus" },
  error: null,
  busy: false,
  sessionRevision: 0,
  getAccessToken: vi.fn().mockResolvedValue("access-token"),
  signIn: vi.fn().mockResolvedValue(true),
  signOut: vi.fn().mockResolvedValue(true),
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AccountAuthControl", () => {
  it("closes the account menu for an outside press without consuming the next action", () => {
    const continueAction = vi.fn();
    renderWithIntl(
      <AuthContext.Provider value={signedInAuth}>
        <AccountAuthControl />
        <button type="button" onClick={continueAction}>Continue planning</button>
      </AuthContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();

    const outsideAction = screen.getByRole("button", { name: "Continue planning" });
    fireEvent.pointerDown(outsideAction);
    fireEvent.click(outsideAction);

    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(continueAction).toHaveBeenCalledTimes(1);
  });
});
