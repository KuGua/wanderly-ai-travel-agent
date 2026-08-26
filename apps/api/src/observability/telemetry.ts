import pino from "pino";
import type { Context, Span } from "@opentelemetry/api";
import type { RequestContext } from "../utils/context.js";
import { getActiveSpan } from "./tracing.js";

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
  "req.body.question",
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
  "res.body.userMessage.content",
  "res.body.assistantMessage.content",
  "res.body.messages.*.content",
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
  traceId?: string,
  spanId?: string,
): pino.Logger {
  // If the caller didn't pass ids, pull from the active OpenTelemetry span.
  // The span context is only consulted when SDK is enabled; when disabled,
  // `getActiveSpan` returns undefined and the binding is skipped silently.
  const activeSpan = traceId === undefined || spanId === undefined ? getActiveSpan() : undefined;
  const spanContext = activeSpan?.spanContext();
  const resolvedTraceId = traceId ?? spanContext?.traceId;
  const resolvedSpanId = spanId ?? spanContext?.spanId;
  const bindings: Record<string, string> = { correlationId };
  if (clientRequestId) bindings.clientRequestId = clientRequestId;
  if (resolvedTraceId && resolvedTraceId !== "00000000000000000000000000000000") {
    bindings.trace_id = resolvedTraceId;
  }
  if (resolvedSpanId && resolvedSpanId !== "0000000000000000") {
    bindings.span_id = resolvedSpanId;
  }
  return base.child(bindings);
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    /**
     * W3C trace id (32 lowercase hex chars). Server-owned: derived from
     * `traceparent` when present, otherwise freshly minted by
     * `apps/api/src/observability/tracing.ts#newTraceId`. Distinct from
     * `correlationId`, which remains the canonical request UUID for logs
     * and audit.
     */
    traceId: string;
    /**
     * W3C span id for the inbound HTTP server span (16 lowercase hex chars).
     * Populated together with `traceId` in the `onRequest` hook.
     */
    spanId: string;
    /**
     * Client-generated request id (from the `X-Request-Id` header). The
     * server always owns `correlationId`; this field carries the client
     * id verbatim when supplied so logs can correlate browser → server.
     */
    clientRequestId?: string;
    rawBody?: string;
    /**
     * Internal: the OpenTelemetry span attached to this request. Set in
     * `onRequest`, ended in `onResponse`. Handlers that want to attach
     * attributes should reference this field rather than calling
     * `trace.getActiveSpan()` (the active span is also installed, but
     * this reference avoids one map lookup).
     */
    _otelSpan?: Span;
    /**
     * Internal: an OTel `Context` that carries the active span. Stored so
     * sub-tasks (notably the durable Worker handoff) can re-enter the
     * context without having to walk the call stack.
     */
    _otelContext?: Context;
  }
}

export type { RequestContext };
