# Provider boundary

`ModelGateway` calls a configured server-side OpenAI, Gemini, or OpenAI-compatible model and returns only structured candidate plans and private conversation replies. Conversation replies normalize Gemini's documented OpenAI-compatible root-level `content` response to the application's `{ reply: { content } }` contract; no other malformed response is accepted. A missing key, timeout, upstream failure, or invalid response fails the request and records a safe agent-run result; it never uses a local substitute.

Travel providers implement the typed Flight, Stay, Place, Navigation, Mobility, and Transit interfaces. Their result is either `LIVE` with source and capture time, or `UNAVAILABLE` with a bounded reason. `PlanningService` fails closed when any required capability is unavailable or lacks evidence.

The provider factory currently exposes unavailable implementations until a supplier adapter and its credentials have been approved and configured. This is intentional: no static price, inventory, location, visa, or booking result is substituted.
