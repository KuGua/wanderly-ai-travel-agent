import { z } from "zod";

/**
 * Team Agent 协作编排 — Trip 约束字段目录（详见 [./constraint-field-catalog.md]）。
 *
 * 这是 `trip_constraint_proposals` / `trip_constraint_facts` 写入路径上**唯一**的白名单。
 * Personal Agent、Owner 表单、Shared planning prompt 都不能创建或替换目录条目；它们只能
 * 选择 `fieldKey` + `value` 并提交 visibility / strength 决策，由服务端校验后才落库。
 *
 * 不变量（来自 `docs/team-agent-orchestration-implementation.md` §1, §4）：
 *  - `TEAM_VISIBLE` 对当前 active members 与 Shared Agent 可见；
 *  - `ORCHESTRATOR_CONFIDENTIAL` 只对 owner、projection builder、Shared Agent 当次
 *    planning/replan prompt 可见，绝不出现在其他成员的 API / UI / 解释 / audit / SSE /
 *    日志 / 指标。
 *  - `HARD` 约束不得由模型静默放宽；冲突时返回结构化阻塞结果。`SOFT` 仅参与排序。
 *  - 目录条目可以选择性要求 `profileConsentRequired`；如需 profile 派生字段，必须同时
 *    拥有当前 Trip scope 的 `consent_grants`（这不是 consent bypass）。
 */

export type ConstraintVisibility =
  | "TEAM_VISIBLE"
  | "ORCHESTRATOR_CONFIDENTIAL";

export type ConstraintStrength = "HARD" | "SOFT";

export interface ConstraintFieldDescriptor {
  key: string;
  valueSchema: z.ZodTypeAny;
  allowedVisibilities: readonly ConstraintVisibility[];
  allowedStrengths: readonly ConstraintStrength[];
  profileConsentRequired: boolean;
  residualInferenceWarningToken: string | null;
  safePublicExplanationTokens: readonly string[];
  proposalEligible: boolean;
}

const departureCitySchema = z.object({
  city: z.string().min(1).max(64),
  countryCode: z.string().length(2).optional(),
}).strict();

const travelDateWindowSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

const budgetMaxSchema = z.object({
  amountUsd: z.number().int().positive().max(100_000),
  rationale: z.string().max(280).optional(),
}).strict();

const accessibilityNeedSchema = z.object({
  category: z.enum([
    "MOBILITY",
    "VISION",
    "HEARING",
    "COGNITIVE",
    "OTHER",
  ]),
  notes: z.string().max(280).optional(),
}).strict();

const specialScheduleLimitSchema = z.object({
  kind: z.enum([
    "MEDICATION_WINDOW",
    "CHILD_CARE",
    "WORK_BLOCK",
    "OTHER",
  ]),
  description: z.string().min(1).max(280),
}).strict();

const noRedEyeSchema = z.object({
  enabled: z.boolean(),
}).strict();

const accommodationStyleSchema = z.object({
  style: z.enum(["city_center", "budget", "luxury", "boutique"]),
}).strict();

const travelPaceSchema = z.object({
  pace: z.enum(["relaxed", "balanced", "packed"]),
}).strict();

const interestsSchema = z.object({
  topics: z.array(z.string().min(1).max(40)).max(12),
}).strict();

export const CONSTRAINT_FIELD_CATALOG = {
  departure_city: {
    key: "departure_city",
    valueSchema: departureCitySchema,
    allowedVisibilities: ["TEAM_VISIBLE"],
    allowedStrengths: ["HARD"],
    profileConsentRequired: false,
    residualInferenceWarningToken: null,
    safePublicExplanationTokens: ["MATCHES_BRIEF_DEPARTURE"],
    proposalEligible: true,
  },
  travel_date_window: {
    key: "travel_date_window",
    valueSchema: travelDateWindowSchema,
    allowedVisibilities: ["TEAM_VISIBLE"],
    allowedStrengths: ["HARD"],
    profileConsentRequired: false,
    residualInferenceWarningToken: null,
    safePublicExplanationTokens: ["MATCHES_BRIEF_WINDOW"],
    proposalEligible: true,
  },
  budget_max: {
    key: "budget_max",
    valueSchema: budgetMaxSchema,
    allowedVisibilities: ["TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"],
    allowedStrengths: ["HARD", "SOFT"],
    profileConsentRequired: true,
    residualInferenceWarningToken: "BUDGET_RESIDUAL_INFERENCE",
    safePublicExplanationTokens: [
      "OPTIMIZED_FOR_BUDGET",
      "SATISFIES_ALL_PRIVATE_CONSTRAINTS",
    ],
    proposalEligible: true,
  },
  accessibility_need: {
    key: "accessibility_need",
    valueSchema: accessibilityNeedSchema,
    allowedVisibilities: ["TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"],
    allowedStrengths: ["HARD", "SOFT"],
    profileConsentRequired: true,
    residualInferenceWarningToken: "ACCESSIBILITY_RESIDUAL_INFERENCE",
    safePublicExplanationTokens: [
      "ACCESSIBILITY_AWARE_SELECTION",
      "SATISFIES_ALL_PRIVATE_CONSTRAINTS",
    ],
    proposalEligible: true,
  },
  special_schedule_limit: {
    key: "special_schedule_limit",
    valueSchema: specialScheduleLimitSchema,
    allowedVisibilities: ["TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"],
    allowedStrengths: ["HARD", "SOFT"],
    profileConsentRequired: false,
    residualInferenceWarningToken: "SCHEDULE_RESIDUAL_INFERENCE",
    safePublicExplanationTokens: [
      "SCHEDULE_AWARE_SELECTION",
      "SATISFIES_ALL_PRIVATE_CONSTRAINTS",
    ],
    proposalEligible: true,
  },
  no_red_eye: {
    key: "no_red_eye",
    valueSchema: noRedEyeSchema,
    allowedVisibilities: ["TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"],
    allowedStrengths: ["HARD", "SOFT"],
    profileConsentRequired: false,
    residualInferenceWarningToken: null,
    safePublicExplanationTokens: ["AVOIDS_RED_EYE"],
    proposalEligible: true,
  },
  accommodation_style: {
    key: "accommodation_style",
    valueSchema: accommodationStyleSchema,
    allowedVisibilities: ["TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"],
    allowedStrengths: ["SOFT"],
    profileConsentRequired: true,
    residualInferenceWarningToken: "STYLE_RESIDUAL_INFERENCE",
    safePublicExplanationTokens: ["MATCHES_STYLE_PREFERENCE"],
    proposalEligible: true,
  },
  travel_pace: {
    key: "travel_pace",
    valueSchema: travelPaceSchema,
    allowedVisibilities: ["TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"],
    allowedStrengths: ["SOFT"],
    profileConsentRequired: true,
    residualInferenceWarningToken: "PACE_RESIDUAL_INFERENCE",
    safePublicExplanationTokens: ["MATCHES_PACE_PREFERENCE"],
    proposalEligible: true,
  },
  interests: {
    key: "interests",
    valueSchema: interestsSchema,
    allowedVisibilities: ["TEAM_VISIBLE"],
    allowedStrengths: ["SOFT"],
    profileConsentRequired: true,
    residualInferenceWarningToken: null,
    safePublicExplanationTokens: ["MATCHES_INTERESTS"],
    proposalEligible: true,
  },
} as const satisfies Record<string, ConstraintFieldDescriptor>;

export type ConstraintFieldKey = keyof typeof CONSTRAINT_FIELD_CATALOG;

export const CONSTRAINT_FIELD_KEYS: readonly ConstraintFieldKey[] =
  Object.freeze(Object.keys(CONSTRAINT_FIELD_CATALOG) as ConstraintFieldKey[]);

export interface ValidatedConstraintField {
  fieldKey: ConstraintFieldKey;
  valueJson: unknown;
  visibility: ConstraintVisibility;
  strength: ConstraintStrength;
}

export class ConstraintFieldCatalogError extends Error {
  readonly statusCode = 422;
  readonly code:
    | "UNKNOWN_FIELD"
    | "VALUE_INVALID"
    | "VISIBILITY_NOT_ALLOWED"
    | "STRENGTH_NOT_ALLOWED"
    | "NOT_PROPOSAL_ELIGIBLE";

  constructor(
    code: ConstraintFieldCatalogError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ConstraintFieldCatalogError";
    this.code = code;
  }
}

export function parseConstraintField(input: {
  fieldKey: string;
  value: unknown;
  visibility: ConstraintVisibility;
  strength: ConstraintStrength;
}): ValidatedConstraintField {
  const descriptor =
    CONSTRAINT_FIELD_CATALOG[input.fieldKey as ConstraintFieldKey];
  if (!descriptor) {
    throw new ConstraintFieldCatalogError(
      "UNKNOWN_FIELD",
      `Field "${input.fieldKey}" is not in the catalog`,
    );
  }
  if (!descriptor.proposalEligible) {
    throw new ConstraintFieldCatalogError(
      "NOT_PROPOSAL_ELIGIBLE",
      `Field "${input.fieldKey}" is not proposal-eligible; use the dedicated form only`,
    );
  }
  if (!(descriptor.allowedVisibilities as readonly ConstraintVisibility[]).includes(input.visibility)) {
    throw new ConstraintFieldCatalogError(
      "VISIBILITY_NOT_ALLOWED",
      `Field "${descriptor.key}" does not allow visibility "${input.visibility}"`,
    );
  }
  if (!(descriptor.allowedStrengths as readonly ConstraintStrength[]).includes(input.strength)) {
    throw new ConstraintFieldCatalogError(
      "STRENGTH_NOT_ALLOWED",
      `Field "${descriptor.key}" does not allow strength "${input.strength}"`,
    );
  }
  const parsedValue = descriptor.valueSchema.safeParse(input.value);
  if (!parsedValue.success) {
    throw new ConstraintFieldCatalogError(
      "VALUE_INVALID",
      `Field "${descriptor.key}" value does not match catalog schema: ${
        parsedValue.error.issues.map(i => i.message).join("; ")
      }`,
    );
  }
  return {
    fieldKey: descriptor.key,
    valueJson: parsedValue.data,
    visibility: input.visibility,
    strength: input.strength,
  };
}

/**
 * 决定 confirmation UI 是否必须渲染「残余推断风险」复选/警告。
 * 即便 owner 选择 `ORCHESTRATOR_CONFIDENTIAL`，若该字段对方案会产生可推断信号，
 * 也必须在 UI 展示该 token 对应的本地化文案（参见 `trips.residualInferenceWarning`）。
 */
export function requiresResidualInferenceWarning(
  fieldKey: ConstraintFieldKey,
): string | null {
  return CONSTRAINT_FIELD_CATALOG[fieldKey].residualInferenceWarningToken;
}

/**
 * Shared Agent 输出 explanation 时允许出现的 token 集合。Phase 3 的
 * `assertConfidentialFree` 会用此 set 反向校验 plan JSON 中是否夹带了私密值。
 */
export function safePublicExplanationTokensFor(
  fieldKey: ConstraintFieldKey,
): readonly string[] {
  return CONSTRAINT_FIELD_CATALOG[fieldKey].safePublicExplanationTokens;
}
