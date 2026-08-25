import pino from "pino";
import type { RequestContext } from "../utils/context.js";

export const LOGGER_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "req.headers['x-sandbox-signature']",
  "req.body.password",
  "req.body.secret",
  "req.body.apiKey",
  "req.body.accessToken",
  "req.body.refreshToken",
  "req.body.passportNumber",
  "req.body.documentNumber",
  "req.body.nationality",
  "req.body.dateOfBirth",
  "req.body.prompt",
  "req.body.privateConversation",
  "req.body.memberPreferences",
  "req.body.*.passportNumber",
  "req.body.*.documentNumber",
  "req.body.*.nationality",
  "req.body.*.dateOfBirth",
  "res.headers['set-cookie']",
  "res.body.passportNumber",
  "res.body.documentNumber",
  "res.body.nationality",
  "res.body.dateOfBirth",
  "res.body.violations",
  "err.config.headers.authorization",
  "err.config.headers['x-api-key']",
  "err.request.headers.authorization",
  "err.request.headers['x-sandbox-signature']",
  "err.response.data",
  "req.body.*.body",
  "req.body.*.message",
  "req.body.*.privateMessage",
  "res.body.*.body",
] as const;

export const LOGGER_REDACTION = {
  paths: [...LOGGER_REDACT_PATHS],
  censor: "[REDACTED]",
};

export const pinoInstance: pino.Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  redact: LOGGER_REDACTION,
});

export function correlationChild(
  base: pino.Logger,
  correlationId: string,
  clientRequestId?: string | null,
): pino.Logger {
  const bindings: Record<string, string> = { correlationId };
  if (clientRequestId) bindings.clientRequestId = clientRequestId;
  return base.child(bindings);
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    traceId: string;
    /**
     * Client-generated request id (from the `X-Request-Id` header). The
     * server always owns `correlationId`; this field carries the client
     * id verbatim when supplied so logs can correlate browser → server.
     */
    clientRequestId?: string;
    rawBody?: string;
  }
}

export type { RequestContext };
