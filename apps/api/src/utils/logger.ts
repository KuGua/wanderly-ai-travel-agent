import { pinoInstance } from "../observability/telemetry.js";

// Re-export for backward compatibility — the canonical instance now lives in
// observability/telemetry.ts so Fastify can wire it consistently.
export const logger = pinoInstance;