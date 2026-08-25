import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "./auth-provider";
import type { BrowserAuthService } from "./cognito-browser-auth";

describe("AuthProvider", () => {
  it("restores a session and removes authenticated request behavior on logout", async () => {
    let accessToken: string | null = "live-access-token";
    const service: BrowserAuthService = {
      configured: true,
      restoreSession: vi.fn().mockResolvedValue({ username: "traveler@example.test" }),
      signIn: vi.fn(),
      signOut: vi.fn().mockImplementation(async () => { accessToken = null; }),
      getAccessToken: vi.fn().mockImplementation(async () => accessToken),
    };

    render(<AuthProvider service={service}><AuthProbe /></AuthProvider>);

    expect(await screen.findByText("SIGNED_IN")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read token" }));
    expect(await screen.findByText("live-access-token")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByText("SIGNED_OUT")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Read token" }));
    expect(await screen.findByText("no-token")).toBeInTheDocument();
  });
});

function AuthProbe() {
  const auth = useAuth();
  const [token, setToken] = useState("unread");
  return (
    <div>
      <span>{auth.status}</span>
      <span>{token}</span>
      <button type="button" onClick={() => void auth.getAccessToken().then((value) => setToken(value ?? "no-token"))}>Read token</button>
      <button type="button" onClick={() => void auth.signOut()}>Sign out</button>
    </div>
  );
}
