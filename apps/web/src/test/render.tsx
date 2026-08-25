import { NextIntlClientProvider } from "next-intl";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import type { TravelApi } from "@/lib/api";
import { QueryProvider } from "@/lib/query/provider";

import enMessages from "../../messages/en.json";
import zhMessages from "../../messages/zh.json";

const messages = { en: enMessages, zh: zhMessages } as const;
type Locale = keyof typeof messages;

export function renderWithIntl(
  ui: ReactElement,
  { locale = "en", api, ...options }: RenderOptions & { locale?: Locale; api?: TravelApi } = {},
): RenderResult {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages[locale]}>
      <QueryProvider configuration={api ? { api } : undefined}>{ui}</QueryProvider>
    </NextIntlClientProvider>,
    options,
  );
}
