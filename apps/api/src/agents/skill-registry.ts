import { createHash } from "node:crypto";
import type { AgentKind, Skill, SkillContext, SkillInvocationRecord, SkillScope } from "./contracts.js";
import { SkillError } from "./errors.js";
import { recordAudit } from "../services/audit-service.js";

const skillsByName = new Map<string, Skill<unknown, unknown>>();
const lastUsedVersion = new Map<string, string>();

const FORBIDDEN_PERSONAL_SCOPES: readonly SkillScope[] = [
  "bookings",
  "plan:write:propose",
];

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

export async function invokeSkill<I, O>(
  name: string,
  ctx: SkillContext,
  payload: unknown,
): Promise<O> {
  const skill = getSkill(name);

  try {
    ctx.policyGate.requireScope(skill.allowedTools);
  } catch (err) {
    throw new SkillError("TOOL_NOT_ALLOWED", `Scope rejected for ${name}: ${(err as Error).message}`);
  }

  if (skill.agent === "shared" && !ctx.snapshot) {
    throw new SkillError("SNAPSHOT_REQUIRED", `Shared skill ${name} requires a snapshot`);
  }

  let input: I;
  try {
    input = skill.input.parse(payload) as I;
  } catch (err) {
    throw new SkillError("INPUT_INVALID", `Input validation failed for ${name}: ${(err as Error).message}`);
  }

  const controller = new AbortController();
  const start = Date.now();

  let output: O;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SkillError("TIMEOUT", `Skill ${name} timed out after ${skill.timeoutMs}ms`));
      }, skill.timeoutMs);
    });
    output = await Promise.race([
      skill.handler(ctx, input, controller.signal) as Promise<O>,
      timeout,
    ]);
  } catch (err) {
    if (timer) clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      throw new SkillError("TIMEOUT", `Skill ${name} timed out after ${skill.timeoutMs}ms`);
    }
    throw err;
  }
  if (timer) clearTimeout(timer);

  let parsed: O;
  try {
    parsed = skill.output.parse(output) as O;
  } catch (err) {
    throw new SkillError("OUTPUT_INVALID", `Output validation failed for ${name}: ${(err as Error).message}`);
  }

  const previousVersion = lastUsedVersion.get(skill.name);
  if (previousVersion === skill.version) {
    throw new SkillError(
      "OUTPUT_INVALID",
      `Skill ${skill.name} version ${skill.version} was already invoked in this process (stale_version_reuse)`,
    );
  }
  lastUsedVersion.set(skill.name, skill.version);

  const record: SkillInvocationRecord = {
    skillName: skill.name,
    version: skill.version,
    outputHash: hashOutput(parsed),
    latencyMs: Date.now() - start,
    status: "SUCCESS",
  };

  await recordAudit({
    ctx: ctx.ctx,
    action: "SKILL_INVOKE",
    summary: record as unknown as Record<string, unknown>,
  });

  return parsed;
}

export function __resetRegistryForTests(): void {
  skillsByName.clear();
  lastUsedVersion.clear();
}
