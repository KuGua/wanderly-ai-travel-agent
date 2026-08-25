# LLM gateway

Set `MODEL_GATEWAY_PROVIDER` to `openai`, `gemini`, or `openai-compatible` and provide the corresponding server-side credentials. `gateway-factory.ts` rejects incomplete configuration.

`LLMGateway` requests structured JSON, validates its envelope, records only safe run metadata, and throws a controlled `ModelGatewayError` on failure. The plan validator remains the authority for provider evidence, source provenance, routes, and authorization.
