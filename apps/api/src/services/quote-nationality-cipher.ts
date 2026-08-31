import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Server-side encryption for provider-only quote fields (e.g. Nuitee
 * `guestNationality`). Spec §3.4, §5.1: the plaintext MUST NOT enter
 * the LLM prompt, shared DTO, log, trace, metric label, or audit summary.
 *
 * Uses AWS KMS by default. `local_test` is an explicit development-only
 * AES-256-GCM mode for sandbox testing; it requires a stable 32-byte local
 * key and is rejected outside NODE_ENV=development. There is no automatic
 * KMS-to-local or plaintext fallback.
 */
export interface QuoteNationalityCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

const ENCRYPTION_CONTEXT = { purpose: "ai-travel-agent:hotel-quote-nationality:v1" };
const KMS_PREFIX = "kms:v1:";
const LOCAL_PREFIX = "local_test:v1:";

class AwsKmsQuoteNationalityCipher implements QuoteNationalityCipher {
  constructor(private readonly keyId: string, private readonly client = new KMSClient({})) {}

  async encrypt(plaintext: string): Promise<string> {
    const result = await this.client.send(new EncryptCommand({
      KeyId: this.keyId,
      Plaintext: Buffer.from(plaintext, "utf8"),
      EncryptionContext: ENCRYPTION_CONTEXT,
    }));
    if (!result.CiphertextBlob) throw new Error("KMS returned no ciphertext");
    return `${KMS_PREFIX}${Buffer.from(result.CiphertextBlob).toString("base64")}`;
  }

  async decrypt(ciphertext: string): Promise<string> {
    const result = await this.client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(requirePrefix(ciphertext, KMS_PREFIX), "base64"),
      EncryptionContext: ENCRYPTION_CONTEXT,
    }));
    if (!result.Plaintext) throw new Error("KMS returned no plaintext");
    return Buffer.from(result.Plaintext).toString("utf8");
  }
}

class LocalTestQuoteNationalityCipher implements QuoteNationalityCipher {
  constructor(private readonly key: Buffer) {}

  async encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${LOCAL_PREFIX}${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64")}`;
  }

  async decrypt(ciphertext: string): Promise<string> {
    const payload = Buffer.from(requirePrefix(ciphertext, LOCAL_PREFIX), "base64");
    if (payload.length < 29) throw new Error("Local quote nationality ciphertext is invalid");
    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(payload.length - 16);
    const encrypted = payload.subarray(12, payload.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}

let testCipher: QuoteNationalityCipher | undefined;

function resolveCipher(env: NodeJS.ProcessEnv = process.env): QuoteNationalityCipher {
  if (testCipher) return testCipher;
  const mode = (env.NUITEE_NATIONALITY_CIPHER_MODE ?? "kms").trim().toLowerCase();
  if (mode === "local_test") {
    if (env.NODE_ENV !== "development") throw new Error("local_test quote nationality cipher is development-only");
    const encodedKey = env.NUITEE_NATIONALITY_LOCAL_TEST_KEY?.trim();
    if (!encodedKey) throw new Error("NUITEE_NATIONALITY_LOCAL_TEST_KEY is required for local_test mode");
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32) throw new Error("NUITEE_NATIONALITY_LOCAL_TEST_KEY must be a base64-encoded 32-byte key");
    return new LocalTestQuoteNationalityCipher(key);
  }
  if (mode !== "kms") throw new Error("NUITEE_NATIONALITY_CIPHER_MODE must be kms or local_test");
  const keyId = env.NUITEE_NATIONALITY_KMS_KEY_ID?.trim();
  if (!keyId) throw new Error("NUITEE_NATIONALITY_KMS_KEY_ID is required for quote nationality encryption");
  return new AwsKmsQuoteNationalityCipher(keyId);
}

function requirePrefix(ciphertext: string, prefix: string): string {
  if (!ciphertext.startsWith(prefix)) throw new Error("Quote nationality ciphertext mode does not match configured cipher");
  return ciphertext.slice(prefix.length);
}

export async function encryptQuoteNationality(plaintext: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return resolveCipher(env).encrypt(plaintext);
}

export async function decryptQuoteNationality(ciphertext: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return resolveCipher(env).decrypt(ciphertext);
}

/** Test-only dependency injection. Never invoke from production code. */
export function __setQuoteNationalityCipherForTests(cipher: QuoteNationalityCipher | undefined): void {
  testCipher = cipher;
}
