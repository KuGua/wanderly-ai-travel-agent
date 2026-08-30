import { testPlanningDependencies } from "./tests/helpers/planning.ts";
process.env.PLAN_ENABLE_HOTEL = "false";
const { generatePlan } = await import("./src/services/planning-service.ts");
try {
  const id = await generatePlan({
    ctx: { actorUserId: "00000000-0000-0000-0000-000000000099", correlationId: "test", traceId: "t", spanId: "s" },
    tripId: "00000000-0000-0000-0000-000000000001",
    snapshotId: "00000000-0000-0000-0000-000000000002",
    destination: "Tokyo",
    memberIds: [],
    outputMode: "PROPOSED",
    coverage: {
      allFlights: [],
      allStays: [{
        destination: "Tokyo",
        checkIn: "2026-09-01",
        checkOut: "2026-09-08",
        pricePerNightUsd: 160,
        style: "city_center",
        location: "Test city center",
        source: "Test stay provider",
        capturedAt: "2026-08-25T00:00:00.000Z",
      }],
      allActivities: [],
      evaluatedDestinations: ["Tokyo"],
      missingDestinations: [],
    },
  }, testPlanningDependencies);
  console.log("PLAN_ID:", id);
} catch (e) {
  console.log("ERROR:", e.message);
  if (e.violations) console.log("VIOLATIONS:", JSON.stringify(e.violations, null, 2));
}
