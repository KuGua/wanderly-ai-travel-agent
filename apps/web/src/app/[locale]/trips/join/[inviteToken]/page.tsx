import { JoinTripInvitation } from "@/components/trips/join-trip-invitation";

export default async function JoinTripPage({
  params,
}: {
  params: Promise<{ inviteToken: string }>;
}) {
  const { inviteToken } = await params;
  return <JoinTripInvitation inviteToken={inviteToken} />;
}
