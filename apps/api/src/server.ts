import "dotenv/config";
import { buildApp } from "./app.js";
import { assertLocalDevServerHost, resolveAuthMode } from "./middleware/auth-mode.js";
import { logger } from "./utils/logger.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const AUTH_MODE = resolveAuthMode();
assertLocalDevServerHost(AUTH_MODE, HOST);

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: PORT, host: HOST });
    logger.info({ port: PORT, host: HOST }, "AI Travel Agent API started");
  } catch (err) {
    logger.error(err, "Failed to start server");
    process.exit(1);
  }
}

main();
