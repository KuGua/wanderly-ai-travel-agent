import pino from "pino";

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
  level: LOG_LEVEL,
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  // Redact sensitive fields
  redact: {
    paths: [
      "req.headers.authorization",
      "req.body.passportNumber",
      "req.body.nationality",
      "req.body.dateOfBirth",
      "res.body.passportNumber",
      "res.body.nationality",
    ],
    censor: "[REDACTED]",
  },
});
