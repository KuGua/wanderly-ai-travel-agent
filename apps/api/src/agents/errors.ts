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

export interface SkillViolation {
  path: string;
  reason: string;
}

export class SkillError extends Error {
  public readonly code: SkillErrorCode;
  public readonly violations?: SkillViolation[];

  constructor(
    code: SkillErrorCode,
    message: string,
    violations?: SkillViolation[],
  ) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    this.violations = violations;
  }
}