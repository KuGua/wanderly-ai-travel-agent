import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { STATUS_CODES } from "node:http";
import { ZodError } from "zod";
import { logger } from "../utils/logger.js";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const correlationId = request.correlationId ?? "unknown";
  const isValidationError = error instanceof ZodError;
  const statusCode = isValidationError ? 400 : error.statusCode ?? 500;

  logger.error({
    err: error,
    correlationId,
    method: request.method,
    url: request.url,
    statusCode,
  }, "Request error");

  const message = statusCode >= 500
    ? "Internal server error"
    : isValidationError
      ? "Request validation failed"
      : error.message;
  const errorName = isValidationError
    ? "Bad Request"
    : error instanceof ApiError
      ? error.error
      : !["Error", "FastifyError"].includes(error.name)
        ? error.name
        : STATUS_CODES[statusCode] ?? "Error";

  reply.code(statusCode).send({
    statusCode,
    error: errorName,
    message,
    correlationId,
  });
}
