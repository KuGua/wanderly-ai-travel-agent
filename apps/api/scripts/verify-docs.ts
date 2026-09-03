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
 *   6. The observability README's "### Series" table and the runtime
 *      `MetricsRegistry.describe()` agree in both directions (names, type,
 *      label keys, label values), and every series / PromQL selector named in
 *      docs/observability-slo.md resolves to a registered series.
 *   7. The README's stated `LOGGER_REDACT_PATHS` count matches the array.
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

/**
 * Read a tracked Markdown file with line endings normalised. Windows
 * checkouts leave CRLF in tracked docs, and every parser below matches on
 * a bare newline.
 */
function readDoc(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8").replace(/\r\n/gu, "\n");
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

  // LOGGER_REDACT_PATHS coverage is asserted against the runtime array in
  // checkRedactPathCount(); a regex over the source cannot count it correctly
  // because several paths (e.g. `req.headers['x-api-key']`) contain `]`.
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

// --- Check 6: metric series docs match the runtime registry ---

const OBSERVABILITY_README = join(SRC_ROOT, "observability", "README.md");
const SLO_DOC = resolve(APPS_API_ROOT, "..", "..", "docs", "observability-slo.md");

/** A row of the README "### Series" table. */
interface DocumentedSeries {
  name: string;
  type: string;
  labelKeys: string[];
  /** Every double-quoted token in the "allowed values" cell. */
  values: Set<string>;
}

/**
 * Parse the "### Series" table. Returns null when the heading is absent, which
 * is itself reported as a failure by the caller.
 */
function parseSeriesTable(text: string): DocumentedSeries[] | null {
  const heading = text.indexOf("### Series\n");
  if (heading === -1) return null;
  const rows: DocumentedSeries[] = [];
  for (const line of text.slice(heading).split(/\r?\n/)) {
    if (!line.startsWith("| `")) {
      // Stop at the first non-row line after the table has started.
      if (rows.length > 0 && !line.startsWith("|")) break;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 4) continue;
    const name = cells[0].match(/^`([a-z][a-z0-9_]*)`$/)?.[1];
    if (!name) continue;
    rows.push({
      name,
      type: cells[1],
      labelKeys: cells[2] === "—" ? [] : cells[2].split(",").map(k => k.trim()).filter(Boolean),
      values: new Set(cells[3].match(/"([^"]*)"/g)?.map(v => v.slice(1, -1)) ?? []),
    });
  }
  return rows;
}

/**
 * The registry — not a regex over its source — is the authority. Both
 * directions matter: an undocumented series means a reviewer cannot tell what
 * `/metrics` may emit, and a documented-but-unregistered series means a
 * dashboard panel or alert rule built from this doc binds to a name that will
 * never produce a sample, which reads as "healthy" rather than "broken".
 */
async function checkMetricSeriesDocs(): Promise<void> {
  const metricsModule = await import(
    pathToFileURL(join(SRC_ROOT, "observability", "metrics.ts")).href
  ) as { metrics: { describe(): Array<{ name: string; type: string; allowedLabels: Record<string, readonly string[]> }> } };
  const registered = new Map(metricsModule.metrics.describe().map(s => [s.name, s]));

  const readmeRel = relative(APPS_API_ROOT, OBSERVABILITY_README);
  if (!existsSync(OBSERVABILITY_README)) {
    fail(readmeRel, "observability README is missing");
    return;
  }
  const documented = parseSeriesTable(readDoc(OBSERVABILITY_README));
  if (documented === null) {
    fail(readmeRel, "missing a '### Series' section documenting the metric registry");
    return;
  }

  const documentedByName = new Map(documented.map(row => [row.name, row]));
  for (const row of documented) {
    if (!registered.has(row.name)) {
      fail(readmeRel, `series table documents "${row.name}", which is not registered in metrics.ts`);
    }
  }
  for (const [name, series] of registered) {
    const row = documentedByName.get(name);
    if (!row) {
      fail(readmeRel, `metric "${name}" is registered but missing from the series table`);
      continue;
    }
    if (row.type !== series.type) {
      fail(readmeRel, `metric "${name}" is a ${series.type}; series table says ${row.type}`);
    }
    const expectedKeys = Object.keys(series.allowedLabels).sort();
    const documentedKeys = [...row.labelKeys].sort();
    if (expectedKeys.join(",") !== documentedKeys.join(",")) {
      fail(
        readmeRel,
        `metric "${name}" labels are [${expectedKeys.join(", ")}]; series table says [${documentedKeys.join(", ")}]`,
      );
    }
    const expectedValues = new Set(Object.values(series.allowedLabels).flat());
    for (const value of expectedValues) {
      if (!row.values.has(value)) {
        fail(readmeRel, `metric "${name}" allows label value "${value}", which the series table omits`);
      }
    }
    for (const value of row.values) {
      if (!expectedValues.has(value)) {
        fail(readmeRel, `series table lists label value "${value}" for "${name}", which the registry rejects`);
      }
    }
  }

  checkSloDocSeries(registered);
}

/**
 * The SLO doc lives outside `src/`, so `checkFrameworkDocs` never sees it — yet
 * it is where alert rules and dashboards are specified. Validate the metric
 * names it binds to, plus the label selectors, since a stale label key silently
 * matches nothing in PromQL.
 */
function checkSloDocSeries(
  registered: Map<string, { type: string; allowedLabels: Record<string, readonly string[]> }>,
): void {
  const sloRel = relative(resolve(APPS_API_ROOT, "..", ".."), SLO_DOC).replace(/\\/gu, "/");
  if (!existsSync(SLO_DOC)) {
    fail(sloRel, "SLO doc is missing");
    return;
  }
  const text = readDoc(SLO_DOC);

  // Histograms also expose the derived `_count` / `_sum` / `_bucket` series.
  const resolveSeries = (token: string) => {
    if (registered.has(token)) return token;
    const base = token.replace(/_(count|sum|bucket)$/u, "");
    const series = registered.get(base);
    return series && series.type === "histogram" ? base : null;
  };

  // (a) The "Source series" column of the SLI catalogue names series directly.
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("| `sli.")) continue;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 3) continue;
    for (const match of cells[2].matchAll(/`([a-z][a-z0-9_]*)`/gu)) {
      if (!resolveSeries(match[1])) {
        fail(sloRel, `SLI source series "${match[1]}" is not registered in metrics.ts`);
      }
    }
  }

  // (b) Any PromQL selector, wherever it appears, must use a registered series
  //     with allowed label keys and values.
  for (const match of text.matchAll(/([a-z][a-z0-9_]*)\{([^}]*)\}/gu)) {
    const [, token, selector] = match;
    const name = resolveSeries(token);
    if (!name) {
      fail(sloRel, `PromQL selector references "${token}", which is not registered in metrics.ts`);
      continue;
    }
    const allowedLabels = registered.get(name)!.allowedLabels;
    for (const label of selector.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gu)) {
      const [, key, value] = label;
      const allowed = allowedLabels[key];
      if (!allowed) {
        fail(
          sloRel,
          `PromQL selector on "${name}" filters by label "${key}"; allowed labels are [${Object.keys(allowedLabels).join(", ") || "none"}]`,
        );
        continue;
      }
      if (!allowed.includes(value)) {
        fail(sloRel, `PromQL selector on "${name}" filters ${key}="${value}", which is outside the allow-list`);
      }
    }
  }
}

// --- Check 7: redaction path count matches the runtime array ---

async function checkRedactPathCount(): Promise<void> {
  const telemetry = await import(
    pathToFileURL(join(SRC_ROOT, "observability", "telemetry.ts")).href
  ) as { LOGGER_REDACT_PATHS: readonly string[] };
  const count = telemetry.LOGGER_REDACT_PATHS.length;
  const readmeRel = relative(APPS_API_ROOT, OBSERVABILITY_README);
  if (!existsSync(OBSERVABILITY_README)) return; // already reported
  const text = readDoc(OBSERVABILITY_README);
  if (!text.includes(`${count}-entry`)) {
    fail(readmeRel, `LOGGER_REDACT_PATHS has ${count} entries; README does not state "${count}-entry"`);
  }
}

// --- Main ---

async function main(): Promise<void> {
  checkSourceOfTruthPaths();
  await checkSkillRuntimeMatches();
  checkFrameworkDocs();
  checkSkillFailureModes();
  checkReviewStub();
  await checkMetricSeriesDocs();
  await checkRedactPathCount();

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
