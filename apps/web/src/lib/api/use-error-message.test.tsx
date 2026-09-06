import { renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import zhMessages from "../../../messages/zh.json";
import { TravelApiError } from "./errors";
import { useErrorMessage } from "./use-error-message";

describe("useErrorMessage", () => {
  it("does not expose an English transport message in a Chinese interface", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale="zh" messages={zhMessages}>{children}</NextIntlClientProvider>
    );
    const { result } = renderHook(() => useErrorMessage(), { wrapper });

    expect(result.current(new TravelApiError(
      "The Agent stream is unreachable. The accepted task will continue.",
      null,
      "Network Error",
      null,
    ))).toBe("旅行服务不可达。请检查接口并重试。");
  });
});
