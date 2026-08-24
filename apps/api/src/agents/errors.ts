export type SkillErrorCode =
  | "UNKNOWN_SKILL"
  | "TOOL_NOT_ALLOWED"
  | "INPUT_INVALID"
  | "OUTPUT_INVALID"
  | "TIMEOUT"
  | "PLAN_VALIDATION_FAILED"
  | "SNAPSHOT_REQUIRED"
  | "POLICY_DENIED"
  | "UPSTREAM_FAILURE";

export const SKILL_ERROR_STATUS: Record<SkillErrorCode, number> = {
  UNKNOWN_SKILL: 404,
  TOOL_NOT_ALLOWED: 403,
  INPUT_INVALID: 400,
  OUTPUT_INVALID: 422,
  TIMEOUT: 504,
  PLAN_VALIDATION_FAILED: 422,
  SNAPSHOT_REQUIRED: 400,
  POLICY_DENIED: 403,
  UPSTREAM_FAILURE: 502,
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