import { NextIntlClientProvider } from "next-intl";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import enMessages from "../../messages/en.json";
import zhMessages from "../../messages/zh.json";

const messages = { en: enMessages, zh: zhMessages } as const;
type Locale = keyof typeof messages;

export function renderWithIntl(
  ui: ReactElement,
  { locale = "en", ...options }: RenderOptions & { locale?: Locale } = {},
): RenderResult {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages[locale]}>
      {ui}
    </NextIntlClientProvider>,
    options,
  );
}