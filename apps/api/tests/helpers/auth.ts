import type { VerifyAccessToken } from "../../src/middleware/auth.js";

/**
 * Mints a subject for any `test-<external-id>` token.
 *
 * Suites that touch shared rows (profiles especially) need their own users, or
 * they race each other for the same fixtures. Anything not matching the prefix
 * is still rejected, so invalid-token assertions are unaffected.
 */
export const verifyTestAccessToken: VerifyAccessToken = async (token) => {
  const match = /^test-([a-z0-9][a-z0-9-]*)$/.exec(token);
  if (!match) throw new Error("Invalid test access token");

  return {
    subject: match[1],
    displayName: match[1].charAt(0).toUpperCase() + match[1].slice(1),
  };
};

export function authHeaders(userId: string) {
  return { authorization: `Bearer test-${userId}` };
}
