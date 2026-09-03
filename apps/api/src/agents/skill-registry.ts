import { createHash } from "node:crypto";
import type { AgentKind, Skill, SkillContext, SkillInvocationRecord, SkillScope } from "./contracts.js";
import { SkillError, type SkillErrorCode } from "./errors.js";
import { recordAudit } from "../services/audit-service.js";
import { DefaultPolicyGate } from "./policy-gate.js";
import { logSafeRuntimeEvent } from "../observability/telemetry.js";

const skillsByName = new Map<string, Skill<unknown, unknown>>();

const FORBIDDEN_PERSONAL_SCOPES: readonly SkillScope[] = [
  "bookings",
  "plan:write:propose",
];

/** Codes the registry treats as `retryable` by default when `skill.retry`
 * is declared. Matches the transient subset of `SkillErrorCode`. */
const TRANSIENT_SKILL_ERROR_CODES: readonly SkillErrorCode[] = [
  "TIMEOUT",
  "NETWORK",
  "UPSTREAM_5XX",
  "UPSTREAM_FAILURE",
];

/** Codes that MUST NOT retry regardless of `skill.retry.retryOn`. */
const NEVER_RETRY_CODES: readonly SkillErrorCode[] = [
  "INPUT_INVALID",
  "OUTPUT_INVALID",
  "POLICY_DENIED",
  "TOOL_NOT_ALLOWED",
  "SCHEMA_PARSE",
  "SKILL_VERSION_MISMATCH",
  "SNAPSHOT_REQUIRED",
  "UNKNOWN_SKILL",
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

/**
 * Validate `skill.retry` declarations at registration time per
 * `docs/planner-resilience-and-reflection-implementation.md` §1.6 / §4.2:
 * retry only applies to read paths. A Skill that declares `retry` together
 * with any write scope is refused at registration. This makes the
 * "no retries on side-effecting skills" rule a compile/registration
 * invariant rather than a runtime convention.
 */
function assertRetryDoesNotMutate(skill: Skill<unknown, unknown>): void {
  if (!skill.retry) return;
  const offending = skill.allowedTools.find((scope) => DefaultPolicyGate.isWriteScope(scope));
  if (offending) {
    throw new SkillError(
      "POLICY_DENIED",
      `Skill ${skill.name} declares retry but allowedTools contains write scope ${offending}`,
    );
  }
  if (skill.retry.maxAttempts < 1 || skill.retry.maxAttempts > 3) {
    throw new SkillError(
      "POLICY_DENIED",
      `Skill ${skill.name} retry.maxAttempts must be 1..3, got ${skill.retry.maxAttempts}`,
    );
  }
  if (skill.retry.backoffBaseMs < 0 || skill.retry.rateLimitedDelayMs < 0) {
    throw new SkillError(
      "POLICY_DENIED",
      `Skill ${skill.name} retry delays must be non-negative`,
    );
  }
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
  assertRetryDoesNotMutate(skill as Skill<unknown, unknown>);
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

export interface SkillInvocationOptions {
  expectedVersion?: string;
  signal?: AbortSignal;
}


function isRetryableError(err: unknown, retryOn: readonly SkillErrorCode[]): boolean {
  if (!(err instanceof SkillError)) return false;
  if (NEVER_RETRY_CODES.includes(err.code)) return false;
  if (retryOn.includes(err.code)) return true;
  // Default transient subset for `retryOn: []` callers — matches the
  // pre-P1 implicit behaviour: TIMEOUT/NETWORK/UPSTREAM_5XX/UPSTREAM_FAILURE
  // were always recoverable. RATE_LIMITED is treated separately below.
  return TRANSIENT_SKILL_ERROR_CODES.includes(err.code);
}

function isRateLimited(err: unknown): boolean {
  return err instanceof SkillError && err.code === "RATE_LIMITED";
}

function retryDelayMs(retry: NonNullable<Skill<unknown, unknown>["retry"]>, attempt: number, rateLimited: boolean): number {
  if (rateLimited) return retry.rateLimitedDelayMs;
  const exp = retry.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1));
  return exp + Math.floor(Math.random() * 250);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `skill.handler` with a per-attempt timeout + retry loop. Each attempt
 * gets its own `AbortController.timeout(skill.timeoutMs)` so retry budgets
 * are not summed against the original timeout. Caller-initiated abort
 * (`options.signal.aborted`) short-circuits immediately and never retries —
 * cancellation is not a transient failure.
 */
async function attemptOnce<I, O>(
  skill: Skill<I, O>,
  input: I,
  ctx: SkillContext,
  callerSignal: AbortSignal | undefined,
): Promise<O> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SkillError("TIMEOUT", `Skill ${skill.name} timed out after ${skill.timeoutMs}ms`));
      }, skill.timeoutMs);
    });
    const output = await Promise.race([
      skill.handler(ctx, input, controller.signal) as Promise<O>,
      timeoutPromise,
    ]);
    return output;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function invokeSkill<I, O>(
  name: string,
  ctx: SkillContext,
  payload: unknown,
  options: SkillInvocationOptions = {},
): Promise<O> {
  const skill = getSkill(name);

  if (options.expectedVersion !== undefined && options.expectedVersion !== skill.version) {
    throw new SkillError(
      "SKILL_VERSION_MISMATCH",
      `Skill ${name} version mismatch: expected ${options.expectedVersion}, registered ${skill.version}`,
    );
  }

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

  const retry = skill.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown = undefined;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const raw = await attemptOnce(skill, input, ctx, options.signal);
      // Output validation happens once, post-retry — retrying on the same
      // malformed output would loop indefinitely.
      let parsed: O;
      try {
        parsed = skill.output.parse(raw) as O;
      } catch (err) {
        throw new SkillError("OUTPUT_INVALID", `Output validation failed for ${name}: ${(err as Error).message}`);
      }
      const record: SkillInvocationRecord = {
        skillName: skill.name,
        version: skill.version,
        outputHash: hashOutput(parsed),
        latencyMs: Date.now() - startedAt,
        attempts: attempt,
        status: "SUCCESS",
      };
      await recordAudit({
        ctx: ctx.ctx,
        action: "SKILL_INVOKE",
        summary: record as unknown as Record<string, unknown>,
      });
      if (attempt > 1) {
        logSafeRuntimeEvent(ctx.ctx, {
          component: "worker",
          event: "retry",
          operation: name,
          outcome: "success",
          attempt,
        });
      }
      return parsed;
    } catch (err) {
      lastError = err;
      // Caller cancellation never retries.
      if (options.signal?.aborted) throw err;
      // No retry declared and we've used our single attempt.
      if (!retry || attempt >= maxAttempts) throw err;
      // Non-retryable code (e.g. POLICY_DENIED, INPUT_INVALID) — stop here.
      if (!isRetryableError(err, retry.retryOn)) throw err;
      // Retry budget consumed? Even when maxAttempts>1, refuse to retry if
      // we have nothing left.
      if (attempt >= maxAttempts) throw err;
      const delay = retryDelayMs(retry, attempt, isRateLimited(err));
      const errorCode: SkillErrorCode = err instanceof SkillError ? err.code : "UPSTREAM_FAILURE";
      logSafeRuntimeEvent(ctx.ctx, {
        component: "worker",
        event: "retry",
        operation: name,
        outcome: "retrying",
        attempt,
        errorCode,
        latencyMs: delay,
      });
      await sleep(delay, options.signal ?? new AbortController().signal);
    }
  }
  // Unreachable — the loop either returns or throws on every iteration.
  throw lastError ?? new SkillError("UPSTREAM_FAILURE", `Skill ${name} exhausted retries without outcome`);
}

export function __resetRegistryForTests(): void {
  skillsByName.clear();
}
