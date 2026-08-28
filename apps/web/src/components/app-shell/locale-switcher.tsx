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

  // The rail is only 64px wide, so this is a square tile matching the nav
  // buttons rather than a pill. The native select stays — it is the whole
  // control's keyboard and screen-reader behaviour — but sits invisibly on
  // top, leaving the glyph and locale code as the visible face.
  return (
    <label className="relative grid size-10 cursor-pointer place-items-center border-[1.5px] border-[var(--w-ink)] bg-[var(--w-fog)] text-[var(--w-ink)] wanderly-r-sm wanderly-press hover:bg-[var(--w-highlight)] sm:size-11">
      <Globe aria-hidden="true" className="size-4" />
      <span aria-hidden="true" className="mt-px text-[9px] font-black leading-none">
        {currentLocale === "en" ? "EN" : "中"}
      </span>
      <select
        value={currentLocale}
        onChange={onChange}
        disabled={isPending}
        aria-label={t("langEnglish") + " / " + t("langChinese")}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {routing.locales.map((locale) => (
          <option key={locale} value={locale}>
            {locale === "en" ? t("langEnglish") : t("langChinese")}
          </option>
        ))}
      </select>
    </label>
  );
}