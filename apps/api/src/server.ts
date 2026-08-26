import "dotenv/config";
import { initTracing, shutdownTracing } from "./observability/tracing.js";
import { buildApp } from "./app.js";
import {
  assertAuthModeEnvironment,
  assertLocalDevServerHost,
  resolveAuthMode,
  resolveLocalDevAllowedOrigins,
} from "./middleware/auth-mode.js";
import { logger } from "./utils/logger.js";

// Tracing MUST be initialized before `buildApp()` so the SDK patches the
// instrumented modules we import transitively (notably OpenAI / pino).
await initTracing();

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const AUTH_MODE = resolveAuthMode();
assertAuthModeEnvironment(AUTH_MODE);
assertLocalDevServerHost(AUTH_MODE, HOST);
if (AUTH_MODE === "local-dev") resolveLocalDevAllowedOrigins();

async function main() {
  const app = await buildApp();

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, "API shutdown initiated");
    try {
      await app.close();
    } catch (err) {
      logger.error(err, "Fastify close failed");
    }
    await shutdownTracing();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  try {
    await app.listen({ port: PORT, host: HOST });
    logger.info({ port: PORT, host: HOST }, "AI Travel Agent API started");
  } catch (err) {
    logger.error(err, "Failed to start server");
    process.exit(1);
  }
}

main();
