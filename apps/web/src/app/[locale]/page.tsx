import { redirect } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";

export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: "/home", locale: locale as Locale });
}
