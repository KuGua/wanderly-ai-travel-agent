import { useState } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TravelApi } from "@/lib/api";
import type { TripSummary } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";
import { RecordTrash } from "./record-trash";

const trips = [{ id: "owned", name: "Kyoto", role: "CREATOR" }, { id: "shared", name: "Paris", role: "MEMBER" }] as TripSummary[];
function Harness({ draggedId = null }: { draggedId?: string | null }) {
  const [selection, onSelect] = useState<string | null>(null);
  return <RecordTrash trips={trips} draggedId={draggedId} selection={selection} onSelect={onSelect} onDragClear={() => {}} />;
}
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("dropping only opens confirmation; cancel never deletes and restores focus", () => {
  const deleteTrip = vi.fn();
  renderWithIntl(<Harness draggedId="owned" />, { api: { deleteTrip } as unknown as TravelApi });
  const bin = screen.getByRole("button", { name: "Delete a trip record" });
  fireEvent.drop(bin);
  expect(screen.getByRole("dialog")).toHaveTextContent("Kyoto");
  expect(deleteTrip).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(bin).toHaveFocus();
  expect(deleteTrip).not.toHaveBeenCalled();
});

it("offers a click alternative, excludes members, and confirms deletion only once", async () => {
  let resolve!: () => void;
  const deleteTrip = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
  renderWithIntl(<Harness />, { api: { deleteTrip } as unknown as TravelApi });
  fireEvent.click(screen.getByRole("button", { name: "Delete a trip record" }));
  expect(screen.queryByRole("button", { name: "Paris" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Kyoto" }));
  const confirm = screen.getByRole("button", { name: "Permanently delete" });
  fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(deleteTrip).toHaveBeenCalledExactlyOnceWith("owned"));
  expect(await screen.findByRole("button", { name: "Deleting…" })).toBeDisabled();
  resolve();
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it.each([null, "shared", "unknown"])("ignores external, non-creator or stale drag %s", (draggedId) => {
  const deleteTrip = vi.fn();
  renderWithIntl(<Harness draggedId={draggedId} />, { api: { deleteTrip } as unknown as TravelApi });
  fireEvent.drop(screen.getByRole("button", { name: "Delete a trip record" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(deleteTrip).not.toHaveBeenCalled();
});

it("retains confirmation and permits cancel after permission/network failure", async () => {
  const deleteTrip = vi.fn().mockRejectedValue(new Error("Forbidden"));
  renderWithIntl(<Harness draggedId="owned" />, { api: { deleteTrip } as unknown as TravelApi });
  fireEvent.drop(screen.getByRole("button", { name: "Delete a trip record" }));
  fireEvent.click(screen.getByRole("button", { name: "Permanently delete" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("creator permissions");
  expect(screen.getByRole("dialog")).toHaveTextContent("Kyoto");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
