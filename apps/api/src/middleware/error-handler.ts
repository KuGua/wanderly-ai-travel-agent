import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { STATUS_CODES } from "node:http";
import { ZodError } from "zod";
import { logger } from "../utils/logger.js";
import { PlanValidationError } from "../policy/plan-output-validator.js";
import { SkillError } from "../agents/errors.js";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly error: string,
    message: string,
    public readonly logCategory?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const correlationId = request.correlationId ?? "unknown";

  if (error instanceof SkillError) {
    logger.warn({
      err: error,
      correlationId,
      code: error.code,
      skillStatusCode: error.statusCode,
      violations: error.violations?.length ?? 0,
    }, "SkillError");

    reply.code(error.statusCode).send({
      statusCode: error.statusCode,
      error: error.code,
      message: error.message,
      code: error.code,
      violations: error.violations ?? [],
      correlationId,
    });
    return;
  }

  const isValidationError = error instanceof ZodError;
  const isApiError = error instanceof ApiError;
  const statusCode = isValidationError ? 400 : isApiError ? error.statusCode : error.statusCode ?? 500;

  const route = request.routeOptions?.url ?? "unmatched";
  if (statusCode >= 500) {
    logger.error({ err: error, correlationId, method: request.method, route, statusCode }, "Request error");
  } else {
    logger.warn({
      correlationId,
      method: request.method,
      route,
      statusCode,
      errorCategory: isValidationError
        ? "VALIDATION_REJECTED"
        : isApiError
          ? error.logCategory ?? "API_REJECTED"
          : "REQUEST_REJECTED",
    }, "Request rejected");
  }

  const message = statusCode >= 500
    ? "Internal server error"
    : isValidationError
      ? "Request validation failed"
      : error.message;
  const errorName = isValidationError
    ? "Bad Request"
    : isApiError
      ? error.error
      : !["Error", "FastifyError"].includes(error.name)
        ? error.name
        : STATUS_CODES[statusCode] ?? "Error";

  reply.code(statusCode).send({
    statusCode,
    error: errorName,
    message,
    correlationId,
    ...(error instanceof PlanValidationError ? { violations: error.violations } : {}),
  });
}
