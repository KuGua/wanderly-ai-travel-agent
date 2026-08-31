import { describe, expect, it } from "vitest";

import {
  __setQuoteNationalityCipherForTests,
  decryptQuoteNationality,
  encryptQuoteNationality,
} from "../src/services/quote-nationality-cipher.js";

const localEnv = {
  NODE_ENV: "development",
  NUITEE_NATIONALITY_CIPHER_MODE: "local_test",
  NUITEE_NATIONALITY_LOCAL_TEST_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("quote nationality local_test cipher", () => {
  it("round-trips with a stable local development key", async () => {
    __setQuoteNationalityCipherForTests(undefined);
    const encrypted = await encryptQuoteNationality("SG", localEnv);
    expect(encrypted).toMatch(/^local_test:v1:/);
    await expect(decryptQuoteNationality(encrypted, localEnv)).resolves.toBe("SG");
  });

  it("rejects local_test outside development and mode-mismatched ciphertext", async () => {
    __setQuoteNationalityCipherForTests(undefined);
    await expect(encryptQuoteNationality("SG", { ...localEnv, NODE_ENV: "production" })).rejects.toThrow("development-only");
    await expect(decryptQuoteNationality("kms:v1:AA==", localEnv)).rejects.toThrow("does not match");
  });
});
