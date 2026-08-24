import type { VerifyAccessToken } from "../../src/middleware/auth.js";

export const verifyTestAccessToken: VerifyAccessToken = async (token) => {
  const match = /^test-(alice|bob|chen)$/.exec(token);
  if (!match) throw new Error("Invalid test access token");

  return {
    subject: match[1],
    displayName: match[1].charAt(0).toUpperCase() + match[1].slice(1),
  };
};

export function authHeaders(userId: string) {
  return { authorization: `Bearer test-${userId}` };
}
