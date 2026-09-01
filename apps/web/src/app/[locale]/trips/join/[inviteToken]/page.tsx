import { Suspense } from "react";

import { JoinTripInvitation } from "@/components/trips/join-trip-invitation";

export default async function JoinTripPage({
  params,
}: {
  params: Promise<{ inviteToken: string }>;
}) {
  const { inviteToken } = await params;
  // JoinTripInvitation reads an optional `email` param via useSearchParams,
  // which Next cannot resolve while statically prerendering (see home/page.tsx
  // for the same pattern).
  return (
    <Suspense fallback={null}>
      <JoinTripInvitation inviteToken={inviteToken} />
    </Suspense>
  );
}
