import { PlanningRunDetailView } from "@/components/trips/shared-plan/planning-run-detail-view";

export default async function PlanningRunPage({
  params,
}: {
  params: Promise<{ tripId: string; runId: string }>;
}) {
  const { tripId, runId } = await params;
  return <PlanningRunDetailView tripId={tripId} runId={runId} />;
}
