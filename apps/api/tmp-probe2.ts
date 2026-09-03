import { resolveTripDestinationReference } from "./src/services/destination-reference-service.js";
for (const name of ["纽约玩", "纽约", "New York"]) {
  try {
    const r = await resolveTripDestinationReference({ destinationId: name } as never);
    console.log(name, "→", JSON.stringify(r));
  } catch (e) {
    console.log(name, "→ 抛错:", (e as Error).message.slice(0, 90));
  }
}
