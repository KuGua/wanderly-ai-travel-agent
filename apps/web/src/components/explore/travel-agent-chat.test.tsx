import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TravelAgentChat } from "./travel-agent-chat";

afterEach(cleanup);

describe("TravelAgentChat", () => {
  it("opens from the capsule after a message and closes back to the capsule", () => {
    const onOpenChange = vi.fn();
    render(<TravelAgentChat onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Ask Wanderly" }), { target: { value: "Plan a quiet coastal trip" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(screen.getByRole("dialog", { name: "Wanderly Agent conversation" })).toBeInTheDocument();
    expect(screen.getByText("Plan a quiet coastal trip")).toBeInTheDocument();
    expect(screen.getByText(/visual prototype/i)).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Close conversation" }));
    expect(screen.queryByRole("dialog", { name: "Wanderly Agent conversation" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask Wanderly" })).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("does not open for an empty message", () => {
    render(<TravelAgentChat />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.queryByRole("dialog", { name: "Wanderly Agent conversation" })).not.toBeInTheDocument();
  });

  it("offers the selected place and supports expanding the conversation", () => {
    render(<TravelAgentChat selectedPlace={{ name: "Tokyo", context: "Japan" }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Ask Wanderly" }), { target: { value: "Open chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    fireEvent.click(screen.getByRole("button", { name: "Ask about Tokyo · Japan" }));
    expect(screen.getByRole("textbox", { name: "Message Wanderly Agent" })).toHaveValue("Tell me about Tokyo");

    fireEvent.click(screen.getByRole("button", { name: "Expand conversation" }));
    expect(screen.getByRole("dialog", { name: "Wanderly Agent conversation" })).toHaveAttribute("data-expanded", "true");
    expect(screen.getByRole("button", { name: "Collapse conversation" })).toBeInTheDocument();
  });
});
