import { z } from "zod";

/**
 * Zod schemas for the location-introduction gateway surface.
 *
 * The output is the strict contract the LLM must satisfy: a single
 * `content` string in the supplied locale. The gateway implementation
 * rejects anything else as `SCHEMA_PARSE` and refuses to cache the
 * payload.  See docs/location-introduction-cache-implementation.md §4
 * and §7 for the rationale.
 */

export const locationIntroductionOutputSchema = z.object({
  content: z.string().trim().min(60).max(720),
}).strict();

export type LocationIntroductionOutput = z.infer<typeof locationIntroductionOutputSchema>;

/**
 * Tokens / phrases that would betray a real-time / operational claim.
 * The list is conservative and applied case-insensitively. The model
 * itself is instructed to never emit these, and the gateway double-checks
 * the validated output as a defense-in-depth.
 */
const FORBIDDEN_OUTPUT_PATTERNS: ReadonlyArray<RegExp> = [
  /\btoday\b/i,
  /\bcurrently\b/i,
  /\bright now\b/i,
  /\bnow\b/i,
  /\bthis (?:week|month|year)\b/i,
  /\blatest\b/i,
  /\bupdated\b/i,
  /\b实时\b/,
  /\b今日\b/,
  /\b当前\b/,
  /\b现在\b/,
  /\b最新\b/,
  /\b即将\b/,
  /\$\s?\d/,
  /€\s?\d/,
  /£\s?\d/,
  /¥\s?\d/,
  /\b\d+\s?°[CF]\b/, // temperatures
];

export function assertLocationIntroductionOutputSafe(
  output: LocationIntroductionOutput,
): LocationIntroductionOutput {
  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    if (pattern.test(output.content)) {
      throw new Error(`Location-introduction output rejected by safety pattern: ${pattern}`);
    }
  }
  return output;
}