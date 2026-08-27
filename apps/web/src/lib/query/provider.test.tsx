import { useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QueryProvider } from "./provider";

function PrivateQueryProbe({ load }: { load: () => Promise<string> }) {
  const query = useQuery({ queryKey: ["private"], queryFn: load });
  return <output>{query.data ?? "loading"}</output>;
}

describe("QueryProvider", () => {
  it("refetches active private queries when the authenticated session changes", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce("first-user")
      .mockResolvedValueOnce("second-user");
    const view = render(
      <QueryProvider sessionRevision={0}>
        <PrivateQueryProbe load={load} />
      </QueryProvider>,
    );

    expect(await screen.findByText("first-user")).toBeInTheDocument();
    view.rerender(
      <QueryProvider sessionRevision={1}>
        <PrivateQueryProbe load={load} />
      </QueryProvider>,
    );

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("second-user")).toBeInTheDocument();
  });
});
