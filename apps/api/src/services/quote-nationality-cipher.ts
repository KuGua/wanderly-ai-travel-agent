import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Server-side encryption for provider-only quote fields (e.g. Nuitee
 * `guestNationality`). Spec §3.4, §5.1: the plaintext MUST NOT enter
 * the LLM prompt, shared DTO, log, trace, metric label, or audit summary.
 *
 * MVP implementation uses an XOR pad derived from a per-process key via
 * scrypt. The interface is identical to the production KMS path so the
 * swap is a single file change.
 *
 * The key is sourced from:
 *   1. `NUITEE_NATIONALITY_KMS_KEY_ID` env, if set — production hook
 *      (a real AWS KMS `Encrypt`/`Decrypt` call will replace this module).
 *   2. A process-local secret for dev (`INVITATION_EMAIL_HMAC_SECRET` or a
 *      freshly generated random key when no secret is available).
 *
 * The cipher output is base64(`iv || ciphertext || authTag`) so a single
 * opaque string is stored in `stay_search_provider_authorizations.value_encrypted`.
 */
export class QuoteNationalityCipher {
  private readonly key: Buffer;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const secret = env.NUITEE_NATIONALITY_KMS_KEY_ID?.trim()
      || env.INVITATION_EMAIL_HMAC_SECRET?.trim()
      || randomBytes(32).toString("hex");
    this.key = scryptSync(secret, "quote-nationality-salt", 32);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, authTag]).toString("base64");
  }

  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, "base64");
    if (buf.length < 12 + 16) throw new Error("Cipher payload is too short");
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}

const defaultCipher = new QuoteNationalityCipher();

export function encryptQuoteNationality(plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  // Stateless default instance keeps tests deterministic without DI; production
  // callers that need a stable key use `new QuoteNationalityCipher(env)`.
  return defaultCipher.encrypt(plaintext);
}

export function decryptQuoteNationality(ciphertext: string, env: NodeJS.ProcessEnv = process.env): string {
  return defaultCipher.decrypt(ciphertext);
}
