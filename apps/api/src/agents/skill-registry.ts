import { createHash } from "node:crypto";
import type { AgentKind, Skill, SkillContext, SkillInvocationRecord, SkillScope } from "./contracts.js";
import { SkillError } from "./errors.js";
import { recordAudit } from "../services/audit-service.js";
import { metrics } from "../observability/metrics.js";

const skillsByName = new Map<string, Skill<unknown, unknown>>();
const dedupeCache = new Map<string, { outputHash: string; ts: number }>();

const FORBIDDEN_PERSONAL_SCOPES: readonly SkillScope[] = ["bookings", "plan:write:propose"];
const DEFAULT_DEDUPE_TTL_MS = Number(process.env.SKILL_DEDUPE_TTL_MS ?? 60_000);
const DEDUPE_MAX_ENTRIES = 256;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

function hashOutput(output: unknown): string {
  return createHash("sha256").update(canonicalize(output)).digest("hex");
}

function isAgentKind(value: string): value is AgentKind {
  return value === "personal" || value === "shared" || value === "review";
}

export function registerSkill<I, O>(skill: Skill<I, O>): void {
  if (skillsByName.has(skill.name)) {
    throw new SkillError("UNKNOWN_SKILL", `Skill already registered: ${skill.name}`);
  }
  if (!isAgentKind(skill.agent)) {
    throw new SkillError("POLICY_DENIED", `Invalid agent kind for skill ${skill.name}: ${skill.agent}`);
  }
  if (skill.agent === "personal") {
    const offending = skill.allowedTools.find(scope => FORBIDDEN_PERSONAL_SCOPES.includes(scope));
    if (offending) {
      throw new SkillError(
        "TOOL_NOT_ALLOWED",
        `Personal skill ${skill.name} may not declare scope ${offending}`,
      );
    }
  }
  skillsByName.set(skill.name, skill as Skill<unknown, unknown>);
}

export function getSkill(name: string): Skill<unknown, unknown> {
  const skill = skillsByName.get(name);
  if (!skill) throw new SkillError("UNKNOWN_SKILL", `Skill not registered: ${name}`);
  return skill;
}

export function listSkills(): Skill<unknown, unknown>[] {
  return [...skillsByName.values()];
}

function recordCacheEntry(key: string, outputHash: string): void {
  dedupeCache.set(key, { outputHash, ts: Date.now() });
  if (dedupeCache.size > DEDUPE_MAX_ENTRIES) {
    const oldest = dedupeCache.keys().next().value;
    if (oldest) dedupeCache.delete(oldest);
  }
}

export async function invokeSkill<I, O>(
  name: string,
  ctx: SkillContext,
  payload: unknown,
): Promise<O> {
  const skill = getSkill(name);

  if (skill.agent === "shared" && !ctx.snapshot) {
    throw new SkillError("SNAPSHOT_REQUIRED", `Shared skill ${name} requires a snapshot`);
  }

  try {
    ctx.policyGate.requireScope(skill.allowedTools);
  } catch (err) {
    metrics.inc("plan_validation_failures_total", { reason: "tool_not_allowed" });
    throw new SkillError("TOOL_NOT_ALLOWED", `Scope rejected for ${name}: ${(err as Error).message}`);
  }

  let input: I;
  try {
    input = skill.input.parse(payload) as I;
  } catch (err) {
    throw new SkillError("INPUT_INVALID", `Input validation failed for ${name}: ${(err as Error).message}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), skill.timeoutMs);
  const start = Date.now();

  let output: unknown;
  try {
    output = await skill.handler(ctx, input, controller.signal);
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      metrics.inc("agent_skill_runs_total", { agent: skill.agent, skill: skill.name, result: "timeout" });
      throw new SkillError("TIMEOUT", `Skill ${name} timed out after ${skill.timeoutMs}ms`);
    }
    throw err;
  }
  clearTimeout(timer);

  let validated: O;
  try {
    validated = skill.output.parse(output) as O;
  } catch (err) {
    metrics.inc("agent_skill_runs_total", { agent: skill.agent, skill: skill.name, result: "output_invalid" });
    throw new SkillError("OUTPUT_INVALID", `Output validation failed for ${name}: ${(err as Error).message}`);
  }

  const outputHash = hashOutput(validated);
  const cacheKey = `${skill.name}:${skill.version}`;
  const prev = dedupeCache.get(cacheKey);
  if (prev && prev.outputHash === outputHash && Date.now() - prev.ts < DEFAULT_DEDUPE_TTL_MS) {
    metrics.inc("agent_skill_runs_total", { agent: skill.agent, skill: skill.name, result: "stale_reuse" });
    throw new SkillError(
      "OUTPUT_INVALID",
      `Skill ${skill.name} version ${skill.version} produced the same output within ${DEFAULT_DEDUPE_TTL_MS}ms (stale_version_reuse)`,
    );
  }
  recordCacheEntry(cacheKey, outputHash);

  const record: SkillInvocationRecord = {
    skillName: skill.name,
    version: skill.version,
    outputHash,
    latencyMs: Date.now() - start,
    status: "SUCCESS",
  };

  await recordAudit({
    ctx: ctx.ctx,
    action: "SKILL_INVOKE",
    summary: record as unknown as Record<string, unknown>,
  });
  metrics.inc("agent_skill_runs_total", { agent: skill.agent, skill: skill.name, result: "success" });

  return validated;
}

export function __resetRegistryForTests(): void {
  skillsByName.clear();
  dedupeCache.clear();
}
