import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { eq, or } from "drizzle-orm";

import { db } from "../db/database.js";
import { users } from "../db/schema.js";
import { signJwt, verifyJwt } from "../utils/jwt.js";
import { ApiError } from "../middleware/error-handler.js";

const BCRYPT_ROUNDS = 12;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;

function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a number";
  return null;
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

  app.post("/auth/login", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!identifier || !password) {
      throw new ApiError(422, "Validation Error", "Email/username and password are required");
    }

    const isEmail = EMAIL_PATTERN.test(identifier);
    const lowerIdentifier = identifier.toLowerCase();

    const [user] = await db.select()
      .from(users)
      .where(
        isEmail
          ? eq(users.email, lowerIdentifier)
          : eq(users.username, lowerIdentifier),
      )
      .limit(1);

    if (!user || !user.passwordHash) {
      throw new ApiError(401, "Unauthorized", "Invalid credentials");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new ApiError(401, "Unauthorized", "Invalid credentials");
    }

    const token = signJwt({
      sub: user.id,
      username: user.username ?? user.displayName,
      email: user.email ?? "",
    });

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
}
