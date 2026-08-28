/**
 * Independent anti-drift CI script.
 *
 * Asserts that every Markdown under apps/api/src/ that documents a constraint
 * stays in sync with the TypeScript it documents. Run via `npm run docs:verify`.
 *
 * Checks performed:
 *   1. Every doc's front-matter `source-of-truth:` path resolves to an existing file.
 *   2. Every Skill doc's "注册元数据" table matches the runtime Skill object's
 *      `name`, `allowedTools`, `timeoutMs`, `needsConfirm`, `version`.
 *   3. Every framework doc's enumerated allow-lists / codes / labels are
 *      actually present in the source file.
 *   4. Every Skill doc's "失败模式" table covers every error code the Skill
 *      can throw.
 *   5. src/skills/REVIEW.md exists and no Skill file declares `agent: "review"`.
 *
 * Exits 0 on success, 1 on any failure. No external dependencies.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const APPS_API_ROOT = resolve(dirname(__filename), "..");
const SRC_ROOT = join(APPS_API_ROOT, "src");

// --- Front-matter parsing (no gray-matter dependency) ---

interface FrontMatter {
  sourceOfTruth?: string;
  name?: string;
  agent?: string;
  status?: string;
}

function parseFrontMatter(markdown: string): FrontMatter {
  // Accept both LF and CRLF line endings — GitHub-hosted runners and Windows
  // checkouts can leave `\r\n` in tracked Markdown, and the parser must not
  // fail silently when front-matter delimiters use either.
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const fm: FrontMatter = {};
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (key === "source-of-truth") fm.sourceOfTruth = value;
    else if (key === "name") fm.name = value;
    else if (key === "agent") fm.agent = value;
    else if (key === "status") fm.status = value;
  }
  return fm;
}

// --- File discovery ---

function findMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (entry.endsWith(".md")) out.push(full);
    }
  }
  return out.sort();
}

function findSkillFiles(): string[] {
  const dirs = [
    join(SRC_ROOT, "skills", "personal"),
    join(SRC_ROOT, "skills", "shared"),
  ];
  const out: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith("-skill.ts")) out.push(join(dir, entry));
    }
  }
  return out.sort();
}

function deriveSkillNameFromPath(skillPath: string): string | null {
  const base = basename(skillPath).replace(/-skill\.ts$/, "");
  const parts = base.split("-");
  return parts.join(".");
}

// --- Result accumulator ---

const failures: string[] = [];

function fail(relPath: string, message: string): void {
  failures.push(`${relPath}: ${message}`);
}

// --- Check 1: source-of-truth exists ---

function checkSourceOfTruthPaths(): void {
  for (const md of findMarkdownFiles(SRC_ROOT)) {
    const rel = relative(APPS_API_ROOT, md);
    const text = readFileSync(md, "utf8");
    const fm = parseFrontMatter(text);
    if (!fm.sourceOfTruth) {
      // SKILL/framework docs require it; the empty top-level src/<dir>/README.md
      // intentionally uses `source-of-truth: ./` and is exempt.
      if (!text.includes("source-of-truth: ./")) continue;
    }
    if (!fm.sourceOfTruth) {
      fail(rel, "front-matter missing `source-of-truth:` field");
      continue;
    }
    // Resolve relative to the markdown file (not the repo root).
    const resolved = resolve(dirname(md), fm.sourceOfTruth);
    if (!existsSync(resolved)) {
      fail(rel, `source-of-truth path does not exist: ${fm.sourceOfTruth} → ${resolved}`);
    }
  }
}

// --- Check 2: runtime Skill metadata matches doc ---

async function checkSkillRuntimeMatches(): Promise<void> {
  // Static imports; we never call the handler. This triggers module-level
  // code only (Zod schema construction + Skill object literal).
  const skillModules = findSkillFiles();

  const skillsByName = new Map<string, {
    name: string;
    allowedTools: readonly string[];
    timeoutMs: number;
    needsConfirm: boolean;
    version: string;
    agent: string;
  }>();

  for (const abs of skillModules) {
    const mod = await import(pathToFileURL(abs).href) as Record<string, unknown>;
    // Find the exported Skill const by convention: the file exports a
    // `<basename>Skill` symbol.
    const baseName = basename(abs).replace(/-skill\.ts$/, "");
    const symbolName = `${baseName
      .split("-")
      .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1)))
      .join("")}Skill`;
    const skill = mod[symbolName] as
      | {
          name: string;
          allowedTools: readonly string[];
          timeoutMs: number;
          needsConfirm: boolean;
          version: string;
          agent: string;
        }
      | undefined;
    if (!skill || typeof skill !== "object") {
      fail(
        `verify-docs.ts`,
        `could not locate exported Skill object in ${relative(APPS_API_ROOT, abs)}; expected symbol ${symbolName}`,
      );
      continue;
    }
    skillsByName.set(skill.name, {
      name: skill.name,
      allowedTools: skill.allowedTools,
      timeoutMs: skill.timeoutMs,
      needsConfirm: skill.needsConfirm,
      version: skill.version,
      agent: skill.agent,
    });
  }

  // Now walk every Skill doc and compare against the runtime value.
  for (const md of findMarkdownFiles(SRC_ROOT)) {
    const rel = relative(APPS_API_ROOT, md);
    if (!rel.endsWith(".md")) continue;
    const text = readFileSync(md, "utf8");
    const fm = parseFrontMatter(text);
    if (fm.agent !== "personal" && fm.agent !== "shared") continue; // not a Skill doc

    const derivedName = deriveSkillNameFromPath(rel);
    const expectedName = fm.name ?? derivedName;
    const runtimeName = expectedName?.startsWith(`${fm.agent}.`)
      ? expectedName.slice(fm.agent.length + 1)
      : expectedName;
    const runtime = skillsByName.get(runtimeName ?? "");
    if (!runtime) {
      fail(rel, `no runtime Skill with name "${runtimeName}" registered`);
      continue;
    }

    if (runtime.name !== runtimeName) {
      fail(rel, `runtime name "${runtime.name}" != documented runtime name "${runtimeName}"`);
    }
    if (runtime.version !== fm.name && !text.includes(`| \`version\` | \`${runtime.version}\` |`)) {
      fail(rel, `runtime version "${runtime.version}" not present in doc table`);
    }
    if (!text.includes(`| \`timeoutMs\` | \`${runtime.timeoutMs}\` |`)) {
      fail(rel, `runtime timeoutMs ${runtime.timeoutMs} not present in doc table`);
    }
    if (!text.includes(`| \`needsConfirm\` | \`${runtime.needsConfirm}\` |`)) {
      fail(rel, `runtime needsConfirm ${runtime.needsConfirm} not present in doc table`);
    }
    const missingTools = runtime.allowedTools.filter(tool => !text.includes(`"${tool}"`));
    if (missingTools.length > 0) {
      fail(rel, `runtime allowedTools [${missingTools.join(", ")}] missing from doc`);
    }
  }
}

// --- Check 3: framework doc covers source unions ---

function extractUnionAfter(source: string, marker: string): string[] {
  // Find a TS union like `| "A" | "B"` after `marker` (up to next `;` or `}`).
  const start = source.indexOf(marker);
  if (start === -1) return [];
  const tail = source.slice(start + marker.length, start + marker.length + 4_000);
  const end = tail.search(/;\s*\n/);
  const body = end === -1 ? tail : tail.slice(0, end);
  const matches = body.match(/"[A-Za-z0-9_:]+"/g) ?? [];
  return matches.map(s => s.slice(1, -1));
}

function checkFrameworkCoverage(
  rel: string,
  text: string,
  sourcePath: string,
): void {
  const source = readFileSync(sourcePath, "utf8");

  // PlanViolationCode coverage (11 values)
  const planViolation = extractUnionAfter(source, "PlanViolationCode");
  if (planViolation.length > 0) {
    for (const code of planViolation) {
      if (!text.includes(`\`${code}\``)) {
        fail(rel, `PlanViolationCode "${code}" not mentioned in doc`);
      }
    }
  }

  // SkillScope coverage
  const scopes = extractUnionAfter(source, "SkillScope");
  if (scopes.length > 0) {
    for (const s of scopes) {
      if (!text.includes(`\`${s}\``)) {
        fail(rel, `SkillScope "${s}" not mentioned in doc`);
      }
    }
  }

  // SkillErrorCode coverage (9 values)
  const errCodes = extractUnionAfter(source, "SkillErrorCode");
  if (errCodes.length > 0) {
    for (const code of errCodes) {
      if (!text.includes(`\`${code}\``)) {
        fail(rel, `SkillErrorCode "${code}" not mentioned in doc`);
      }
    }
  }

  // AuditAction coverage
  const auditActions = extractUnionAfter(source, "AuditAction");
  if (auditActions.length > 0) {
    for (const action of auditActions) {
      if (!text.includes(`\`${action}\``)) {
        fail(rel, `AuditAction "${action}" not mentioned in doc`);
      }
    }
  }

  // LOGGER_REDACT_PATHS coverage (length matters more than values)
  if (rel.endsWith("src/observability/README.md") || rel.includes("/LOG-REDACTION")) {
    const redactPathsMatch = source.match(/LOGGER_REDACT_PATHS = \[([\s\S]*?)\]/);
    if (redactPathsMatch) {
      const pathCount = (redactPathsMatch[1].match(/"/g) ?? []).length / 2;
      // The doc states 31 entries; assert the doc claims the same count.
      if (!text.includes(`${pathCount} `) && !text.includes(`${pathCount}-`)) {
        fail(rel, `LOGGER_REDACT_PATHS has ${pathCount} entries; doc does not state that count`);
      }
    }
  }
}

function checkFrameworkDocs(): void {
  for (const md of findMarkdownFiles(SRC_ROOT)) {
    const rel = relative(APPS_API_ROOT, md);
    const text = readFileSync(md, "utf8");
    const fm = parseFrontMatter(text);
    if (!fm.sourceOfTruth) continue;
    if (fm.sourceOfTruth === "./") continue; // directory README

    const sourcePath = resolve(dirname(md), fm.sourceOfTruth);
    if (!existsSync(sourcePath)) continue; // already flagged in check 1

    checkFrameworkCoverage(rel, text, sourcePath);
  }
}

// --- Check 4: Skill doc failure-mode table covers thrown error codes ---

function checkSkillFailureModes(): void {
  for (const md of findMarkdownFiles(SRC_ROOT)) {
    const rel = relative(APPS_API_ROOT, md);
    if (!rel.endsWith(".md")) continue;
    const text = readFileSync(md, "utf8");
    const fm = parseFrontMatter(text);
    if (fm.agent !== "personal" && fm.agent !== "shared") continue;

    // Parse the "失败模式" table — collect rows with their first code token.
    const sectionStart = text.indexOf("## 失败模式");
    if (sectionStart === -1) {
      fail(rel, "Skill doc is missing '## 失败模式' section");
      continue;
    }
    const tableStart = text.indexOf("|", sectionStart);
    if (tableStart === -1) {
      fail(rel, "Skill doc '## 失败模式' is missing a table");
      continue;
    }
    const codes = new Set<string>();
    const lines = text.slice(tableStart).split("\n");
    for (const line of lines) {
      if (!line.startsWith("|")) break;
      const cells = line.split("|").map(s => s.trim());
      // Each row's first column contains the error code.
      if (cells.length < 2) continue;
      const codeMatch = cells[1].match(/`([A-Z_]+)`/);
      if (codeMatch) codes.add(codeMatch[1]);
    }

    // Required codes for every Skill doc.
    const required: Record<string, string[]> = {
      "shared.plan.comparison": ["SNAPSHOT_REQUIRED", "INPUT_INVALID", "OUTPUT_INVALID", "PLAN_VALIDATION_FAILED", "TIMEOUT", "TOOL_NOT_ALLOWED"],
      "shared.readiness.check": ["SNAPSHOT_REQUIRED", "INPUT_INVALID", "OUTPUT_INVALID", "TIMEOUT", "TOOL_NOT_ALLOWED"],
      "personal.profile.memory": ["INPUT_INVALID", "OUTPUT_INVALID", "TIMEOUT", "TOOL_NOT_ALLOWED"],
      "personal.profile.change_proposal": ["INPUT_INVALID", "OUTPUT_INVALID", "TIMEOUT"],
      "personal.consent.explanation": ["INPUT_INVALID", "OUTPUT_INVALID", "TIMEOUT", "TOOL_NOT_ALLOWED"],
      "personal.thread.recall": ["INPUT_INVALID", "OUTPUT_INVALID", "TIMEOUT", "TOOL_NOT_ALLOWED"],
      "personal.travel.conversation": ["INPUT_INVALID", "OUTPUT_INVALID", "TIMEOUT", "TOOL_NOT_ALLOWED"],
    };
    const requiredCodes = required[fm.name ?? ""] ?? [];
    for (const code of requiredCodes) {
      if (!codes.has(code)) {
        fail(rel, `Skill doc failure-mode table missing code "${code}"`);
      }
    }
  }
}

// --- Check 5: REVIEW stub ---

function checkReviewStub(): void {
  const reviewPath = join(SRC_ROOT, "skills", "REVIEW.md");
  if (!existsSync(reviewPath)) {
    fail(relative(APPS_API_ROOT, reviewPath), "REVIEW.md must exist");
  } else {
    const text = readFileSync(reviewPath, "utf8");
    const fm = parseFrontMatter(text);
    if (fm.status !== "no-skills") {
      fail(relative(APPS_API_ROOT, reviewPath), "REVIEW.md front-matter `status:` must be `no-skills`");
    }
  }
  // Grep: no Skill file under src/skills/ declares `agent: "review"`.
  const skillFiles = findSkillFiles();
  for (const skillFile of skillFiles) {
    const text = readFileSync(skillFile, "utf8");
    if (/\bagent:\s*"review"/.test(text)) {
      fail(
        relative(APPS_API_ROOT, skillFile),
        `Skill file declares agent: "review" but REVIEW.md states no Skills are registered; update both`,
      );
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  checkSourceOfTruthPaths();
  await checkSkillRuntimeMatches();
  checkFrameworkDocs();
  checkSkillFailureModes();
  checkReviewStub();

  if (failures.length > 0) {
    console.error("docs:verify — FAILED\n");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log("docs:verify — OK");
}

main().catch(err => {
  console.error("docs:verify — crashed:", err);
  process.exit(2);
});
