import { createHash } from "node:crypto";
import type {
  ConstraintSnapshotDataV2,
  ConstraintVisibility,
  ConstraintStrength,
  ProjectedConstraint,
  ConstraintSnapshotProjectionManifestEntry,
} from "../types/schemas.js";
import type {
  ConstraintFieldKey,
} from "../policy/constraint-field-catalog.js";

/**
 * Team Agent 协作编排 — immutable constraint snapshot v2 projection builder.
 *
 * 这是 `constraint_snapshots.authorized_data` 列**唯一**的写入入口。
 * 读取路径见 `apps/api/src/policy/snapshot-policy.ts`（v1 兼容分流）；v2 shape 由
 * `apps/api/src/types/schemas.ts#constraintSnapshotDataV2Schema` 定义。
 *
 * 重要不变量（来自 `docs/team-agent-orchestration-implementation.md` §1, §3.4, §5.3）：
 *  - `memberAliases` 是 run-scoped 临时键；model 永远看不到 userId。
 *  - 任何 confidential 数据只能进入 `orchestratorConfidential`，且必须同步出现在
 *    `projectionManifest` 中以便 §10.2 验证链路。
 *  - 该服务在 `db.transaction` 内被 `services/planning-service.ts#createConstraintSnapshot`
 *    和 `constraint-fact-service.ts` 事务性调用，事务的提交顺序是：
 *    1) 写 trip_constraint_facts Active 行；
 *    2) 调用 `stalePlansAndConfirmationsForTrip`；
 *    3) 写 `constraint_snapshots`；
 *    4) enqueue REPLAN outbox。
 */

export interface ActiveConsentGrant {
  userId: string;
  scope: "PROFILE_BASIC" | "PROFILE_PREFERENCES" | "PROFILE_NATIONALITY"
    | "PROFILE_DOCUMENTS" | "PROFILE_BUDGET" | "PROFILE_RESTRICTIONS";
  fieldList: readonly string[];
}

export interface ActiveTripConstraintFact {
  ownerUserId: string;
  fieldKey: string;
  visibility: ConstraintVisibility;
  strength: ConstraintStrength;
  valueJson: unknown;
  revision: number;
  id: string;
}

export interface MemoryProjectionInput {
  tripId: string;
  memberUserIds: readonly string[];
  consents: readonly ActiveConsentGrant[];
  tripConstraintFacts: readonly ActiveTripConstraintFact[];
  departureCities: readonly string[];
  destinationCandidates: readonly string[];
  travelDateStart?: string;
  travelDateEnd?: string;
}

export interface MemoryProjectionResult {
  snapshot: ConstraintSnapshotDataV2;
  projectionManifest: readonly ConstraintSnapshotProjectionManifestEntry[];
}

/**
 * 构造 run-scoped 别名。Phase 1 实现在用户 id 前 8 字符加盐得到稳定短串；
 * 不能反推回 userId。
 */
export function buildMemberAliases(
  memberUserIds: readonly string[],
  salt?: string,
): Record<string, string> {
  const nonce = salt ?? Math.random().toString(36).slice(2, 10);
  const aliases: Record<string, string> = {};
  for (const userId of memberUserIds) {
    const digest = createHash("sha256")
      .update(`${nonce}:${userId}`)
      .digest("hex");
    aliases[userId] = `m_${digest.slice(0, 10)}`;
  }
  return aliases;
}

/**
 * Fold a fact or consent field into `projectedConstraint[]` shape (envelope only).
 */
function toProjectedConstraint(params: {
  fieldKey: string;
  valueJson: unknown;
  strength: ConstraintStrength;
  visibility: ConstraintVisibility;
  sourceType: "PROFILE_CONSENT" | "TRIP_FACT";
  sourceId: string;
  revision?: number;
}): ProjectedConstraint {
  const base = {
    fieldKey: params.fieldKey,
    valueJson: params.valueJson,
    strength: params.strength,
    visibility: params.visibility,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
  };
  return params.revision !== undefined
    ? { ...base, revision: params.revision }
    : base;
}

/**
 * 主投影函数。不会触碰数据库，调用方负责将 member list / consents /
 * trip_constraint_facts 在事务内 fetch 出来。
 */
export function buildMemoryProjection(input: MemoryProjectionInput): MemoryProjectionResult {
  const aliases = buildMemberAliases(input.memberUserIds);
  const teamVisible: Record<string, ProjectedConstraint[]> = {};
  const orchestratorConfidential: Record<string, ProjectedConstraint[]> = {};
  const projectionManifest: ConstraintSnapshotProjectionManifestEntry[] = [];

  // Initialize per-member buckets (preserves stability when a member has no constraints).
  for (const alias of Object.values(aliases)) {
    teamVisible[alias] = [];
    orchestratorConfidential[alias] = [];
  }

  // 1. Each consent scope contributes profile fields — only TEAM_VISIBLE.
  for (const consent of input.consents) {
    const alias = aliases[consent.userId];
    if (!alias) continue; // non-member consent is impossible by FK but be defensive
    for (const fieldKey of consent.fieldList) {
      teamVisible[alias].push(toProjectedConstraint({
        fieldKey,
        valueJson: null, // value comes from profile row by `sourceId`, not in projection
        strength: "SOFT",
        visibility: "TEAM_VISIBLE",
        sourceType: "PROFILE_CONSENT",
        sourceId: `consent:${consent.userId}:${consent.scope}:${fieldKey}`,
      }));
    }
  }

  // 2. Each trip_constraint_facts ACTIVE row contributes per its `visibility`.
  for (const fact of input.tripConstraintFacts) {
    const alias = aliases[fact.ownerUserId];
    if (!alias) continue;
    const target = fact.visibility === "TEAM_VISIBLE" ? teamVisible : orchestratorConfidential;
    target[alias].push(toProjectedConstraint({
      fieldKey: fact.fieldKey,
      valueJson: fact.valueJson,
      strength: fact.strength,
      visibility: fact.visibility,
      sourceType: "TRIP_FACT",
      sourceId: fact.id,
      revision: fact.revision,
    }));
    projectionManifest.push({
      sourceType: "TRIP_FACT",
      sourceId: fact.id,
      revision: fact.revision,
      visibility: fact.visibility,
    });
  }

  return {
    snapshot: {
      schemaVersion: 2,
      memberAliases: aliases,
      teamVisible,
      orchestratorConfidential,
      projectionManifest,
      departureCities: [...input.departureCities],
      destinationCandidates: [...input.destinationCandidates],
      travelDateStart: input.travelDateStart,
      travelDateEnd: input.travelDateEnd,
    },
    projectionManifest,
  };
}

/**
 * 把 confidential projection 折叠成 server-internal opaque 字节流（仅用于诊断 dump）；
 * 绝不用于序列化到任何用户可见的 API 响应。
 */
export function encodeOrchestratorConfidentialSection(
  section: Record<string, ProjectedConstraint[]>,
): string {
  // 仅用 sha256 摘要每个 value_json，不保留明文。任何调用方必须自己保证审计。
  const line = JSON.stringify(section);
  return createHash("sha256").update(line).digest("hex");
}

/**
 * 写 snapshot 前的 manifest revision guard。
 * 当 `proposedManifest` 不等于已存在快照的 manifest 时，返回 true。
 * `trip_constraint_facts` mutation 事务可借此决定是否触发 REPLAN enqueue。
 */
export function isManifestSupersession(params: {
  previousManifest?: readonly ConstraintSnapshotProjectionManifestEntry[];
  proposedManifest: readonly ConstraintSnapshotProjectionManifestEntry[];
}): boolean {
  if (!params.previousManifest) return params.proposedManifest.length > 0;
  if (params.previousManifest.length !== params.proposedManifest.length) return true;
  const prev = new Set(params.previousManifest.map(m => `${m.sourceId}:${m.revision}`));
  for (const entry of params.proposedManifest) {
    if (!prev.has(`${entry.sourceId}:${entry.revision}`)) return true;
  }
  return false;
}

export type {
  ConstraintFieldKey,
};
