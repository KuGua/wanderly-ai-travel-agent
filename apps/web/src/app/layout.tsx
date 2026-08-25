import type { ReactNode } from "react";

// Root layout must exist, but `<html>`/`<body>` live in the locale layout so
// that `lang={locale}` can be set dynamically from the `[locale]` segment.
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}