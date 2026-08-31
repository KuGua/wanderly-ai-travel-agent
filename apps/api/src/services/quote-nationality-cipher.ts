import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

/**
 * Server-side encryption for provider-only quote fields (e.g. Nuitee
 * `guestNationality`). Spec §3.4, §5.1: the plaintext MUST NOT enter
 * the LLM prompt, shared DTO, log, trace, metric label, or audit summary.
 *
 * Uses AWS KMS Encrypt/Decrypt in every runtime environment. The configured
 * key identifier is an ARN or alias, never symmetric key material. Missing
 * configuration or KMS failure is deliberately fail-closed; there is no
 * local, random-key, or plaintext fallback. The ciphertext is base64-encoded
 * KMS output stored in `stay_search_provider_authorizations.value_encrypted`.
 */
export interface QuoteNationalityCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

const ENCRYPTION_CONTEXT = { purpose: "ai-travel-agent:hotel-quote-nationality:v1" };

class AwsKmsQuoteNationalityCipher implements QuoteNationalityCipher {
  constructor(private readonly keyId: string, private readonly client = new KMSClient({})) {}

  async encrypt(plaintext: string): Promise<string> {
    const result = await this.client.send(new EncryptCommand({
      KeyId: this.keyId,
      Plaintext: Buffer.from(plaintext, "utf8"),
      EncryptionContext: ENCRYPTION_CONTEXT,
    }));
    if (!result.CiphertextBlob) throw new Error("KMS returned no ciphertext");
    return Buffer.from(result.CiphertextBlob).toString("base64");
  }

  async decrypt(ciphertext: string): Promise<string> {
    const result = await this.client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, "base64"),
      EncryptionContext: ENCRYPTION_CONTEXT,
    }));
    if (!result.Plaintext) throw new Error("KMS returned no plaintext");
    return Buffer.from(result.Plaintext).toString("utf8");
  }
}

let testCipher: QuoteNationalityCipher | undefined;

function resolveCipher(env: NodeJS.ProcessEnv = process.env): QuoteNationalityCipher {
  if (testCipher) return testCipher;
  const keyId = env.NUITEE_NATIONALITY_KMS_KEY_ID?.trim();
  if (!keyId) throw new Error("NUITEE_NATIONALITY_KMS_KEY_ID is required for quote nationality encryption");
  return new AwsKmsQuoteNationalityCipher(keyId);
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
