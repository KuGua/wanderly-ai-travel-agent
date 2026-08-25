import { ArrowLeft, Construction } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

export default async function TripPlaceholderPage() {
  const t = await getTranslations("trips");
  return (
    <main className="grid min-h-[70vh] place-items-center px-5 py-12">
      <section className="w-full max-w-xl rounded-3xl border bg-card p-8 text-center shadow-sm">
        <Construction aria-hidden="true" className="mx-auto size-10 text-primary" />
        <p className="mt-5 text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t("kicker")}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-4 text-muted-foreground">{t("body")}</p>
        <Link href="/home" className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl font-semibold text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
          <ArrowLeft aria-hidden="true" className="size-4" /> {t("backToHome")}
        </Link>
      </section>
    </main>
  );
}