"use client";

import { Globe } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import { routing } from "@/i18n/routing";
import { usePathname, useRouter } from "@/i18n/navigation";

export function LocaleSwitcher() {
  const t = useTranslations("common");
  const currentLocale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  function onChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const nextLocale = event.target.value as (typeof routing.locales)[number];
    startTransition(() => {
      router.replace(pathname, { locale: nextLocale });
    });
  }

  return (
    <label className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-sidebar/95 px-3 py-2 text-xs font-bold text-white shadow-lg focus-within:ring-2 focus-within:ring-white/50">
      <Globe aria-hidden="true" className="size-4" />
      <span className="sr-only">{t("langEnglish")} / {t("langChinese")}</span>
      <select
        value={currentLocale}
        onChange={onChange}
        disabled={isPending}
        aria-label={t("langEnglish") + " / " + t("langChinese")}
        className="bg-transparent text-white outline-none"
      >
        {routing.locales.map((locale) => (
          <option key={locale} value={locale} className="text-black">
            {locale === "en" ? t("langEnglish") : t("langChinese")}
          </option>
        ))}
      </select>
    </label>
  );
}