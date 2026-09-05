"use client";

import { Globe } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import { SelectMenu } from "@/components/ui/select-menu";
import { routing } from "@/i18n/routing";
import { usePathname, useRouter } from "@/i18n/navigation";

export function LocaleSwitcher() {
  const t = useTranslations("common");
  const currentLocale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const options = routing.locales.map((locale) => ({
    value: locale,
    label: locale === "en" ? t("langEnglish") : t("langChinese"),
  }));

  // The rail is only 64px wide, so this stays a square tile matching the nav
  // buttons — same size as before. What changed is the list it opens: a native
  // `<select>` draws its options with the operating system's own widget, which
  // no CSS reaches, so the one stock grey list on the page appeared here.
  return (
    <SelectMenu
      value={currentLocale}
      options={options}
      align="end"
      ariaLabel={`${t("langEnglish")} / ${t("langChinese")}`}
      disabled={isPending}
      onChange={(nextLocale) => {
        startTransition(() => {
          router.replace(pathname, { locale: nextLocale as (typeof routing.locales)[number] });
        });
      }}
      triggerClassName="grid size-10 cursor-pointer place-items-center border-[1.5px] border-[var(--w-ink)] bg-[var(--w-fog)] text-[var(--w-ink)] outline-none wanderly-r-sm wanderly-press hover:bg-[var(--w-cal-run)] focus-visible:ring-4 focus-visible:ring-[var(--w-info)]/40 sm:size-11"
      renderTrigger={() => (
        <>
          <Globe aria-hidden="true" className="size-4" />
          <span aria-hidden="true" className="mt-px text-[9px] font-black leading-none">
            {currentLocale === "en" ? "EN" : "中"}
          </span>
        </>
      )}
    />
  );
}
