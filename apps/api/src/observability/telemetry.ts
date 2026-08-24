import pino from "pino";
import type { RequestContext } from "../utils/context.js";

export const pinoInstance: pino.Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-sandbox-signature']",
      "req.body.passportNumber",
      "req.body.nationality",
      "req.body.dateOfBirth",
      "req.body.orchestrationRequestId",
      "res.body.passportNumber",
      "res.body.nationality",
      "res.body.violations",
    ],
    censor: "[REDACTED]",
  },
});

export function correlationChild(base: pino.Logger, correlationId: string): pino.Logger {
  return base.child({ correlationId });
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    traceId: string;
  }
}

export type { RequestContext };