import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger.js";

export async function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const correlationId = request.correlationId ?? "unknown";

  logger.error({
    err: error,
    correlationId,
    method: request.method,
    url: request.url,
    statusCode: error.statusCode ?? 500,
  }, "Request error");

  const statusCode = error.statusCode ?? 500;
  const message = statusCode >= 500 ? "Internal server error" : error.message;

  reply.code(statusCode).send({
    statusCode,
    error: error.name ?? "Error",
    message,
    correlationId,
  });
}
