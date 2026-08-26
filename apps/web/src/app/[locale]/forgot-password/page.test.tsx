import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "@/test/render";

const resetMocks = vi.hoisted(() => ({
  request: vi.fn(),
  verify: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/lib/auth/custom-browser-auth", () => ({
  requestPasswordReset: resetMocks.request,
  verifyResetCode: resetMocks.verify,
  resetPassword: resetMocks.reset,
}));

import ForgotPasswordPage from "./page";

describe("ForgotPasswordPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks.request.mockResolvedValue({ developmentCode: "123456", retryAfterSeconds: 60 });
    resetMocks.verify.mockResolvedValue("one-use-reset-token");
    resetMocks.reset.mockResolvedValue(undefined);
  });

  it("completes email, six-digit verification, matching password, and success steps", async () => {
    renderWithIntl(<ForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "traveler@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));

    const codeInput = await screen.findByLabelText("Verification code");
    expect(codeInput).toHaveValue("123456");
    expect(screen.getByText("Resend in 60s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    const password = await screen.findByLabelText("New password");
    const confirmation = screen.getByLabelText("Confirm new password");
    fireEvent.change(password, { target: { value: "NewPassword1" } });
    fireEvent.change(confirmation, { target: { value: "Different1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(resetMocks.reset).not.toHaveBeenCalled();

    fireEvent.change(confirmation, { target: { value: "NewPassword1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("heading", { name: "Password reset complete" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Back to Sign in" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Back to Sign in" })[0]).toHaveAttribute("href", "/login");
    expect(screen.getByText("Redirecting to sign in in 5s...")).toBeInTheDocument();
    await waitFor(() => expect(resetMocks.reset).toHaveBeenCalledWith({
      email: "traveler@example.test",
      resetToken: "one-use-reset-token",
      password: "NewPassword1",
      confirmPassword: "NewPassword1",
    }));
  });
});
