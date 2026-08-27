import { CognitoJwtVerifier } from "aws-jwt-verify";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import { db } from "../db/database.js";
import { users } from "../db/schema.js";
import { verifyJwt } from "../utils/jwt.js";
import { ApiError } from "./error-handler.js";
import {
  assertAuthModeEnvironment,
  isLoopbackAddress,
  LOCAL_DEV_DISPLAY_NAME,
  LOCAL_DEV_EXTERNAL_ID,
  resolveAuthMode,
  type AuthMode,
} from "./auth-mode.js";

export interface AuthenticatedIdentity {
  subject: string;
  displayName?: string;
}

export type VerifyAccessToken = (token: string) => Promise<AuthenticatedIdentity>;

export interface AuthMiddlewareOptions {
  mode?: AuthMode;
  nodeEnv?: string;
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
let verifierConfiguration: string | undefined;

export async function verifyCognitoAccessToken(token: string): Promise<AuthenticatedIdentity> {
  const userPoolId = process.env.COGNITO_USER_POOL_ID?.trim();
  const clientId = process.env.COGNITO_CLIENT_ID?.trim();

  if (!userPoolId || !clientId) {
    throw new ApiError(503, "Service Unavailable", "Authentication service is not configured");
  }

  const configuration = `${userPoolId}:${clientId}`;
  if (!verifier || verifierConfiguration !== configuration) {
    verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
    verifierConfiguration = configuration;
  }

  const payload = await verifier.verify(token);
  return {
    subject: payload.sub,
    displayName: typeof payload.username === "string" ? payload.username : undefined,
  };
}

export function createAuthMiddleware(
  verifyAccessToken: VerifyAccessToken = verifyCognitoAccessToken,
  options: AuthMiddlewareOptions = {},
) {
  const mode = options.mode ?? resolveAuthMode();
  assertAuthModeEnvironment(mode, options.nodeEnv ?? process.env.NODE_ENV);

  return async function authMiddleware(request: FastifyRequest) {
    let identity: AuthenticatedIdentity;

    if (mode === "local-dev") {
      if (!isLoopbackAddress(request.ip)) {
        throw new ApiError(403, "Forbidden", "Local development authentication requires a loopback client");
      }
      identity = { subject: LOCAL_DEV_EXTERNAL_ID, displayName: LOCAL_DEV_DISPLAY_NAME };
    } else {
      const authorization = request.headers.authorization;
      const match = typeof authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;

      if (!match) {
        throw new ApiError(401, "Unauthorized", "A valid bearer access token is required");
      }

      if (mode === "custom-local") {
        const customPayload = verifyJwt(match[1]);
        if (!customPayload) {
          throw new ApiError(401, "Unauthorized", "A valid bearer access token is required");
        }
        request.user = await resolveCustomLocalUser(customPayload.sub);
        return;
      } else {
        try {
          identity = await verifyAccessToken(match[1]);
        } catch (error) {
          if (error instanceof ApiError && error.statusCode === 503) throw error;
          throw new ApiError(401, "Unauthorized", "A valid bearer access token is required");
        }
      }
    }

    if (!identity.subject.trim()) {
      throw new ApiError(401, "Unauthorized", "A valid bearer access token is required");
    }

    request.user = await provisionAuthenticatedUser(identity);
  };
}

async function resolveCustomLocalUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    throw new ApiError(401, "Unauthorized", "A valid bearer access token is required");
  }

  return {
    id: user.id,
    externalId: user.externalId,
    displayName: user.displayName,
  };
}

async function provisionAuthenticatedUser(identity: AuthenticatedIdentity) {
  const displayName = identity.displayName?.trim().slice(0, 128) || "Traveler";
  let userRecords = await db.select().from(users).where(eq(users.externalId, identity.subject)).limit(1);

  if (userRecords.length === 0) {
    await db.insert(users).values({
      externalId: identity.subject,
      displayName,
    }).onConflictDoNothing({ target: users.externalId });
    userRecords = await db.select().from(users).where(eq(users.externalId, identity.subject)).limit(1);
  }

  const user = userRecords[0];
  if (!user) {
    throw new ApiError(503, "Service Unavailable", "Authenticated user could not be provisioned");
  }

  return {
    id: user.id,
    externalId: user.externalId,
    displayName: user.displayName,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    user: {
      id: string;
      externalId: string;
      displayName: string;
    };
  }
}
