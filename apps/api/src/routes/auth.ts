import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { eq, or } from "drizzle-orm";

import { db } from "../db/database.js";
import { users } from "../db/schema.js";
import { REMEMBERED_TOKEN_EXPIRY_SECONDS, signJwt, verifyJwt } from "../utils/jwt.js";
import { ApiError } from "../middleware/error-handler.js";
import { passwordResetEmailConfigured, sendPasswordResetCode } from "../services/password-reset-email.js";

const BCRYPT_ROUNDS = 12;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;

const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const CODE_COOLDOWN_MS = 60 * 1000; // 60 seconds between sends
const MAX_CODE_ATTEMPTS = 5;

type ResetEntry = {
  mode: "direct" | "email-code";
  codeHash?: string;
  expiresAt: number;
  sentAt: number;
  attempts: number;
  userExists: boolean;
  resetTokenHash?: string;
};

const resetCodes = new Map<string, ResetEntry>();

function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a number";
  return null;
}

function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safelyMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(digest(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function passwordResetMode(): "direct" | "email-code" {
  const configured = process.env.PASSWORD_RESET_MODE?.trim().toLowerCase();
  if (configured === "direct" || configured === "email-code") return configured;
  return "direct";
}

function pruneExpiredCodes() {
  const now = Date.now();
  for (const [key, entry] of resetCodes) {
    if (entry.expiresAt < now) resetCodes.delete(key);
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

    const errors: Record<string, string> = {};

    if (!USERNAME_PATTERN.test(username)) {
      errors.username = "Username must be 3-32 characters (letters, numbers, underscore)";
    }
    if (!EMAIL_PATTERN.test(email)) {
      errors.email = "Invalid email address";
    }
    if (password !== confirmPassword) {
      errors.confirmPassword = "Passwords do not match";
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      errors.password = passwordError;
    }

    if (Object.keys(errors).length > 0) {
      throw new ApiError(422, "Validation Error", JSON.stringify(errors));
    }

    const existing = await db.select({ id: users.id })
      .from(users)
      .where(or(eq(users.email, email), eq(users.username, username)))
      .limit(1);

    if (existing.length > 0) {
      throw new ApiError(409, "Conflict", "Username or email already taken");
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [user] = await db.insert(users).values({
      externalId: `custom:${username}`,
      displayName: username,
      username,
      email,
      passwordHash,
    }).returning({ id: users.id });

    const token = signJwt({ sub: user.id, username, email });

    reply.code(201).send({
      token,
      user: { id: user.id, username, email },
    });
  });

  // Demo-only convenience: lets the invitation join page decide whether to
  // point an invited recipient at sign-in or register. Not a security
  // boundary — deliberately not rate-limited or auth-gated.
  app.get("/auth/check-email", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const email = typeof query.email === "string" ? query.email.trim().toLowerCase() : "";

    if (!EMAIL_PATTERN.test(email)) {
      throw new ApiError(422, "Validation Error", "Invalid email address");
    }

    const [user] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    reply.send({ exists: Boolean(user) });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const rememberMe = body.rememberMe === true;

    if (!username || !password) {
      throw new ApiError(422, "Validation Error", "Username and password are required");
    }

    const [user] = await db.select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (!user || !user.passwordHash) {
      throw new ApiError(401, "Unauthorized", "Invalid credentials");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new ApiError(401, "Unauthorized", "Invalid credentials");
    }

    const token = signJwt(
      {
        sub: user.id,
        username: user.username ?? user.displayName,
        email: user.email ?? "",
      },
      rememberMe ? REMEMBERED_TOKEN_EXPIRY_SECONDS : undefined,
    );

    reply.send({
      token,
      user: {
        id: user.id,
        username: user.username ?? user.displayName,
        email: user.email ?? "",
      },
    });
  });

  app.get("/auth/me", async (request, reply) => {
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;

    if (!match) {
      throw new ApiError(401, "Unauthorized", "Token required");
    }

    const payload = verifyJwt(match[1]);
    if (!payload) {
      throw new ApiError(401, "Unauthorized", "Invalid or expired token");
    }

    reply.send({
      user: {
        id: payload.sub,
        username: payload.username,
        email: payload.email,
      },
    });
  });

  app.post("/auth/forgot-password", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!EMAIL_PATTERN.test(email)) {
      throw new ApiError(422, "Validation Error", "Invalid email address");
    }

    pruneExpiredCodes();

    const key = digest(email);
    const mode = passwordResetMode();
    const existing = resetCodes.get(key);
    if (mode === "email-code" && existing && Date.now() - existing.sentAt < CODE_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((CODE_COOLDOWN_MS - (Date.now() - existing.sentAt)) / 1000);
      throw new ApiError(429, "Too Many Requests", `Please wait ${waitSeconds} seconds before requesting a new code`);
    }

    const [user] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const now = Date.now();

    if (mode === "direct") {
      const resetToken = randomBytes(32).toString("hex");
      resetCodes.set(key, {
        mode,
        expiresAt: now + CODE_EXPIRY_MS,
        sentAt: now,
        attempts: 0,
        userExists: Boolean(user),
        resetTokenHash: digest(resetToken),
      });

      reply.send({
        mode,
        resetToken,
        message: "Continue to set a new password.",
      });
      return;
    }

    const code = generateCode();

    if (process.env.NODE_ENV === "production") {
      if (!passwordResetEmailConfigured()) {
        throw new ApiError(503, "Service Unavailable", "Password reset email delivery is not configured");
      }
      try {
        await sendPasswordResetCode(email, code);
      } catch {
        request.log.error({ errorCategory: "PASSWORD_RESET_DELIVERY_FAILED" }, "Password reset email delivery failed");
        throw new ApiError(503, "Service Unavailable", "Verification email could not be sent");
      }
    }

    resetCodes.set(key, {
      mode,
      codeHash: digest(code),
      expiresAt: now + CODE_EXPIRY_MS,
      sentAt: now,
      attempts: 0,
      userExists: Boolean(user),
    });

    // Always return success to prevent email enumeration
    const response: Record<string, unknown> = {
      mode,
      message: "If an account with that email exists, a verification code has been sent.",
      retryAfterSeconds: CODE_COOLDOWN_MS / 1000,
    };

    // In local-dev mode, include the code for testing
    if (process.env.NODE_ENV !== "production") {
      response.developmentCode = code;
    }

    reply.send(response);
  });

  app.post("/auth/verify-reset-code", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";

    if (!EMAIL_PATTERN.test(email) || !/^\d{6}$/.test(code)) {
      throw new ApiError(422, "Validation Error", "Email and code are required");
    }

    pruneExpiredCodes();

    const key = digest(email);
    const entry = resetCodes.get(key);
    if (!entry || entry.mode !== "email-code" || !entry.codeHash || entry.expiresAt < Date.now() || entry.attempts >= MAX_CODE_ATTEMPTS) {
      throw new ApiError(401, "Unauthorized", "Invalid or expired verification code");
    }

    if (!entry.userExists || !safelyMatches(code, entry.codeHash)) {
      entry.attempts += 1;
      if (entry.attempts >= MAX_CODE_ATTEMPTS) resetCodes.delete(key);
      throw new ApiError(401, "Unauthorized", "Invalid or expired verification code");
    }

    const resetToken = randomBytes(32).toString("hex");
    entry.resetTokenHash = digest(resetToken);

    reply.send({ resetToken });
  });

  app.post("/auth/reset-password", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const resetToken = typeof body.resetToken === "string" ? body.resetToken : "";
    const password = typeof body.password === "string" ? body.password : "";
    const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

    if (!email || !resetToken) {
      throw new ApiError(422, "Validation Error", "Email and reset token are required");
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      throw new ApiError(422, "Validation Error", passwordError);
    }
    if (password !== confirmPassword) {
      throw new ApiError(422, "Validation Error", "Passwords do not match");
    }

    const key = digest(email);
    const entry = resetCodes.get(key);
    if (!entry?.userExists || !entry.resetTokenHash || !safelyMatches(resetToken, entry.resetTokenHash) || entry.expiresAt < Date.now()) {
      throw new ApiError(401, "Unauthorized", "Invalid or expired reset token");
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = await db.update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.email, email))
      .returning({ id: users.id });

    if (result.length === 0) {
      throw new ApiError(404, "Not Found", "User not found");
    }

    resetCodes.delete(key);

    reply.send({ message: "Password reset successfully" });
  });
}
