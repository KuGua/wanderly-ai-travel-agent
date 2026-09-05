import { describe, expect, it } from "vitest";

import { redactProviderMessage } from "../src/providers/provider-error-diagnostics.js";

describe("redactProviderMessage", () => {
  // A supplier error can quote our own request back, and the SerpApi key
  // travels in the query string. Reading the body to learn why a request was
  // refused must not be a way to get a credential into the logs.
  it("removes credentials a supplier echoed back", () => {
    const echoed = "Invalid request: /search?engine=google_flights&api_key=sk-live-abc123&departure_id=SIN";
    const redacted = redactProviderMessage(echoed);
    expect(redacted).not.toContain("sk-live-abc123");
    expect(redacted).toContain("[REDACTED]");
    // The useful part — which parameter it objected to — must survive.
    expect(redacted).toContain("departure_id=SIN");
  });

  it.each([
    "apikey=secret-value",
    "token=secret-value",
    "access_token=secret-value",
    "key=secret-value",
  ])("redacts %s", (pair) => {
    expect(redactProviderMessage(`rejected ${pair}&x=1`)).not.toContain("secret-value");
  });

  it("truncates a long body so an error page cannot flood the log", () => {
    expect(redactProviderMessage("x".repeat(5_000)).length).toBeLessThanOrEqual(300);
  });

  it("leaves an ordinary message intact", () => {
    expect(redactProviderMessage("Invalid departure_id")).toBe("Invalid departure_id");
  });
});
