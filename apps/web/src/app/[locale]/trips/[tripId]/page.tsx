import { TripWorkspace } from "@/components/trips/trip-workspace";

export default async function TripPage({
  params,
}: {
  params: Promise<{ tripId: string; locale: string }>;
}) {
  const { tripId } = await params;
  return <TripWorkspace tripId={tripId} />;
}
