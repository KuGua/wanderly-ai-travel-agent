export type SkillErrorCode =
  | "UNKNOWN_SKILL"
  | "SKILL_VERSION_MISMATCH"
  | "TOOL_NOT_ALLOWED"
  | "INPUT_INVALID"
  | "OUTPUT_INVALID"
  | "TIMEOUT"
  | "NETWORK"
  | "UPSTREAM_5XX"
  | "SCHEMA_PARSE"
  | "PLAN_VALIDATION_FAILED"
  | "SNAPSHOT_REQUIRED"
  | "POLICY_DENIED"
  | "SEARCH_PREFERENCES_STALE"
  | "UPSTREAM_FAILURE"
  /**
   * P1-A: a provider refused further calls because the quota is exhausted.
   * The retry loop treats this specially — exponential backoff only burns
   * quota faster — and uses `SkillRetryPolicy.rateLimitedDelayMs` instead.
   */
  | "RATE_LIMITED";

export const SKILL_ERROR_STATUS: Record<SkillErrorCode, number> = {
  UNKNOWN_SKILL: 404,
  SKILL_VERSION_MISMATCH: 409,
  TOOL_NOT_ALLOWED: 403,
  INPUT_INVALID: 400,
  OUTPUT_INVALID: 422,
  TIMEOUT: 504,
  NETWORK: 502,
  UPSTREAM_5XX: 502,
  SCHEMA_PARSE: 422,
  PLAN_VALIDATION_FAILED: 422,
  SNAPSHOT_REQUIRED: 400,
  POLICY_DENIED: 403,
  SEARCH_PREFERENCES_STALE: 409,
  UPSTREAM_FAILURE: 502,
  RATE_LIMITED: 429,
};

export interface SkillViolation {
  path: string;
  reason: string;
}

export class SkillError extends Error {
  public readonly code: SkillErrorCode;
  public readonly statusCode: number;
  public readonly violations?: SkillViolation[];

  constructor(
    code: SkillErrorCode,
    message: string,
    violations?: SkillViolation[],
  ) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    this.statusCode = SKILL_ERROR_STATUS[code];
    this.violations = violations;
  }
}
