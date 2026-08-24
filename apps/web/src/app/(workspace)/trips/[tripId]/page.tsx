import { ArrowLeft, Construction } from "lucide-react";
import Link from "next/link";

export default function TripPlaceholderPage() {
  return (
    <main className="grid min-h-[70vh] place-items-center px-5 py-12">
      <section className="w-full max-w-xl rounded-3xl border bg-card p-8 text-center shadow-sm">
        <Construction aria-hidden="true" className="mx-auto size-10 text-primary" />
        <p className="mt-5 text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Next implementation phase</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Trip workspace is not connected yet</h1>
        <p className="mt-4 text-muted-foreground">This Slice only displays fields confirmed by the Trip List contract. Planning, consent and confirmation states have not been inferred.</p>
        <Link href="/home" className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl font-semibold text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"><ArrowLeft aria-hidden="true" className="size-4" /> Back to Home</Link>
      </section>
    </main>
  );
}
