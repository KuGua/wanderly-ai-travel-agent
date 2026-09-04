import { createServer, type Server } from "node:http";

import { metrics } from "../observability/metrics.js";

const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export type WorkerMetricsServer = {
  port: number;
  close: () => Promise<void>;
};

/**
 * Exposes the Worker's separate in-process registry to a task-local collector.
 * The Compose configuration does not publish this port to the host; production
 * deployments should expose it only to their collector sidecar/agent.
 */
export async function startWorkerMetricsServer(options: {
  host?: string;
  port?: number;
} = {}): Promise<WorkerMetricsServer> {
  const host = options.host ?? process.env.WORKER_METRICS_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.WORKER_METRICS_PORT ?? 9464);
  // Port 0 is accepted only through the function parameter, for isolated
  // tests that need the operating system to allocate a free port. An env
  // configuration must always name a stable scrape port.
  const isEphemeralTestPort = options.port === 0;
  if (!Number.isInteger(port) || (!isEphemeralTestPort && port < 1) || port > 65_535) {
    throw new Error("WORKER_METRICS_PORT must be an integer between 1 and 65535");
  }

  const server = createServer((request, response) => {
    const path = request.url?.split("?", 1)[0];
    if (request.method === "GET" && path === "/metrics") {
      response.writeHead(200, { "content-type": PROMETHEUS_CONTENT_TYPE });
      response.end(metrics.render());
      return;
    }
    if (request.method === "GET" && path === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"status":"ok"}');
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end('{"error":"Not Found"}');
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Worker metrics server did not expose a TCP address");
  }
  return { port: address.port, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
