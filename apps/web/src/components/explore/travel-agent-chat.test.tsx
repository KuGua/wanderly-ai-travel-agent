import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { TravelAgentChat } from "./travel-agent-chat";

afterEach(cleanup);

function ChatHarness({ selectedPlace = null }: { selectedPlace?: { name: string; context: string } | null }) {
  const [open, setOpen] = useState(false);
  return <TravelAgentChat open={open} onOpen={() => setOpen(true)} onDismiss={() => setOpen(false)} selectedPlace={selectedPlace} />;
}

describe("TravelAgentChat", () => {
  it("opens from the capsule after a message and closes back to the capsule", () => {
    render(<ChatHarness />);

    fireEvent.change(screen.getByRole("textbox", { name: "Ask Wanderly" }), { target: { value: "Plan a quiet coastal trip" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(screen.getByRole("dialog", { name: "Wanderly Agent conversation" })).toBeInTheDocument();
    expect(screen.getByText("Plan a quiet coastal trip")).toBeInTheDocument();
    expect(screen.getByText(/visual prototype/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
    expect(screen.queryByRole("dialog", { name: "Wanderly Agent conversation" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask Wanderly" })).toBeInTheDocument();
  });

  it("does not open for an empty message", () => {
    render(<ChatHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.queryByRole("dialog", { name: "Wanderly Agent conversation" })).not.toBeInTheDocument();
  });

  it("offers the selected place and supports expanding the conversation", () => {
    render(<ChatHarness selectedPlace={{ name: "Tokyo", context: "Japan" }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Ask Wanderly" }), { target: { value: "Open chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    fireEvent.click(screen.getByRole("button", { name: "Ask about Tokyo · Japan" }));
    expect(screen.getByRole("textbox", { name: "Message Wanderly Agent" })).toHaveValue("Tell me about Tokyo");

    fireEvent.click(screen.getByRole("button", { name: "Expand conversation" }));
    expect(screen.getByRole("dialog", { name: "Wanderly Agent conversation" })).toHaveAttribute("data-expanded", "true");
    expect(screen.getByRole("button", { name: "Collapse conversation" })).toBeInTheDocument();
  });

  it("opens chat history without requiring a message", () => {
    render(<ChatHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    expect(screen.getByRole("dialog", { name: "Wanderly Agent conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Chat history" })).not.toBeInTheDocument();
  });
});
