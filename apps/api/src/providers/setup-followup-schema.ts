/**
 * Output contract for the conversational setup follow-up generator.
 *
 * The model must produce ONE structured question that points at a
 * server-known missing code; the route layer validates against the
 * requested set and falls back to deterministic templates on any
 * rejection. See docs/personal-research-intent-routing-implementation.md
 * §9.
 */

import { z } from "zod";

import { researchMissingCodeSchema } from "../types/schemas.js";

export const setupFollowupOutputSchema = z.object({
  questionCode: researchMissingCodeSchema,
  promptText: z.string().trim().min(1).max(280),
}).strict();

export type SetupFollowupOutput = z.infer<typeof setupFollowupOutputSchema>;

/**
 * PII / fact-bearing patterns. Conservative case-insensitive list. The
 * generator is not allowed to echo anything that smells like a
 * passport, ID, phone, address, or live-fact token. Defense-in-depth on
 * top of the prompt's safety boundary.
 */
const FORBIDDEN_OUTPUT_PATTERNS: ReadonlyArray<RegExp> = [
  // Passport / document / numeric IDs.
  /\b[A-Z]{1,2}\d{6,9}\b/, // passport-like
  /\b\d{9,12}\b/, // generic numeric IDs (>=9 digits)
  // Phone numbers (rough).
  /\+?\d[\d\s().-]{8,}\d/,
  // Currency / price.
  /[¥$€£]\s?\d/,
  /\b\d+\s?(?:USD|CNY|TWD|JPY|EUR|HKD|SGD)\b/i,
  // Live-fact tokens.
  /\b(?:today|tomorrow|tonight|currently|right now|this week|this month)\b/i,
  /\b(?:今日|今晚|明天|现在|当前|本周|本月)\b/,
];

export function assertSetupFollowupOutputSafe(
  output: SetupFollowupOutput,
): SetupFollowupOutput {
  for (const pattern of FORBIDDEN_OUTPUT_PATTERNS) {
    if (pattern.test(output.promptText)) {
      throw new Error(`setup-followup output rejected by safety pattern: ${pattern}`);
    }
  }
  return output;
}
