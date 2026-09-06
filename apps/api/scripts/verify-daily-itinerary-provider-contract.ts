import { assertModelGatewayEnvironment, createModelGateway } from "../src/providers/gateway-factory.js";
import { ModelGatewayError } from "../src/providers/llm-gateway.js";
import { createRequestContext } from "../src/utils/context.js";

/**
 * Staging/release smoke test for the exact provider-facing structured-output
 * contract. It uses only synthetic, non-private aliases and prints a bounded
 * machine-readable result; prompts, completions and credentials are never
 * emitted. This is intentionally opt-in rather than an API startup gate,
 * because daily composition is optional and must not take down core planning.
 */
async function main(): Promise<void> {
  assertModelGatewayEnvironment();
  const gateway = createModelGateway();
  if (!gateway.generateDailyItinerary) {
    throw new Error("Configured model gateway does not implement daily itinerary generation");
  }

  try {
    const result = await gateway.generateDailyItinerary({
      plan: {
        destination: "Contract Test City",
        days: [{ dayKey: "day_1", date: "2099-01-01" }],
        flights: [],
        hotels: [],
        activities: [],
      },
      travelDateStart: "2099-01-01",
      travelDateEnd: "2099-01-01",
      requiredDates: ["2099-01-01"],
      ctx: createRequestContext(),
    });
    if (result.days.length !== 1 || result.days[0]?.dayKey !== "day_1") {
      throw new Error("Provider accepted the request but returned an invalid daily itinerary contract");
    }
    process.stdout.write(`${JSON.stringify({ outcome: "success", dayCount: result.days.length })}\n`);
  } catch (error) {
    const gatewayError = error instanceof ModelGatewayError ? error : null;
    process.stderr.write(`${JSON.stringify({
      outcome: "failure",
      code: gatewayError?.code ?? "INTERNAL_ERROR",
      httpStatus: gatewayError?.details?.httpStatus ?? null,
      schemaFingerprint: gatewayError?.details?.schemaFingerprint ?? null,
    })}\n`);
    process.exitCode = 1;
  }
}

await main();
