import { TripInvitationPage } from "@/components/trips/trip-invitation-page";

export default async function InvitePage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  return <TripInvitationPage tripId={tripId} />;
}
