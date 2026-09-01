/**
 * Personal Research Intent — readiness copy table (Phase 2).
 *
 * Maps the server-stable `blockers[]` / `warnings[]` codes returned in the
 * persisted draft to user-facing Chinese copy. The server contract uses
 * raw codes (per docs/personal-research-intent-routing-implementation.md
 * §4.2) so a downstream string change never breaks the wire format; this
 * lookup is the single client-side translation point.
 *
 * Each code is tagged with a `severity` — `blocker` codes gate the confirm
 * flow (the button stays disabled until every blocker is resolved), `warning`
 * codes are advisory and the owner can proceed past them.
 *
 * Add a new entry here (and a matching copy under `MISSING_COPY`) when the
 * server introduces a new `researchMissingCodeSchema` value. NEVER embed
 * the original question, a place name, or any identifier here — the card
 * body is rendered into the DOM and any leakage becomes recoverable audit
 * data.
 */

export type PersonalResearchMissingCode =
  | "TRIP_NOT_ACTIVE"
  | "DESTINATION_NOT_CONFIGURED"
  | "DATES_MISSING"
  | "FLIGHT_PREFERENCES_MISSING"
  | "STAY_PREFERENCES_MISSING"
  | "HOTEL_PROVIDER_NOT_APPROVED"
  | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING"
  | "ROUTE_ENDPOINTS_UNCONFIRMED"
  | "MODE_NOT_CHOSEN"
  | "BUDGET_HINT_MISSING";

export type PersonalResearchReadiness =
  | "READY"
  | "READY_WITH_WARNINGS"
  | "NEEDS_SETUP"
  | "NEEDS_PLACE_SELECTION";

export type PersonalResearchSeverity = "blocker" | "warning";

export type ResearchCapability =
  | "flight"
  | "accommodation"
  | "hotel"
  | "activities"
  | "places"
  | "navigation"
  | "mobility"
  | "readiness";

/** Capabilities whose research path calls a real external provider. The
 *  user must explicitly acknowledge this before the confirm button fires. */
export const REAL_PROVIDER_CAPABILITIES: ReadonlySet<ResearchCapability> = new Set([
  "flight",
  "hotel",
  "accommodation",
  "activities",
  "places",
  "mobility",
  "navigation",
]);

/** Returns the subset of `requestedCapabilities` that hit real providers. */
export function realProviderCapabilities(
  requested: readonly ResearchCapability[],
): ResearchCapability[] {
  return requested.filter((capability) => REAL_PROVIDER_CAPABILITIES.has(capability));
}

export interface MissingCodeCopy {
  title: string;
  detail: string;
  ctaHint: string;
  severity: PersonalResearchSeverity;
}

export const MISSING_COPY: Record<PersonalResearchMissingCode, MissingCodeCopy> = {
  TRIP_NOT_ACTIVE: {
    title: "行程尚未激活",
    detail: "本研究仍可发起，但行程还在草稿/已取消/陈旧状态。结果可能与最终行程不完全匹配。",
    ctaHint: "建议先在行程页激活 Trip",
    severity: "warning",
  },
  DESTINATION_NOT_CONFIGURED: {
    title: "尚未选择目的地",
    detail: "研究需要先确定目的地。",
    ctaHint: "在行程页填写目的地",
    severity: "blocker",
  },
  DATES_MISSING: {
    title: "尚未填写出行日期",
    detail: "酒店与活动研究依赖出行日期。",
    ctaHint: "在行程页填写出发与返回日期",
    severity: "blocker",
  },
  FLIGHT_PREFERENCES_MISSING: {
    title: "尚未确认航班偏好",
    detail: "本次研究包含航班能力，未确认舱位 / 人数 / 货币时将使用默认值；建议先去偏好页完善以获得更准确的结果。",
    ctaHint: "前往偏好页（可选）",
    severity: "warning",
  },
  STAY_PREFERENCES_MISSING: {
    title: "尚未确认住宿偏好",
    detail: "本次研究包含酒店能力，未确认房间数 / 成人 / 货币时将使用默认值；建议先去偏好页完善。",
    ctaHint: "前往偏好页（可选）",
    severity: "warning",
  },
  HOTEL_PROVIDER_NOT_APPROVED: {
    title: "酒店供应商未启用",
    detail: "当前环境未启用酒店供应商；请稍后再试或联系运维。",
    ctaHint: "联系运维",
    severity: "blocker",
  },
  QUOTE_NATIONALITY_AUTHORIZATION_MISSING: {
    title: "Nuitee 国籍授权缺失",
    detail: "酒店供应商需要有效的国籍授权，请先在授权页完成确认。",
    ctaHint: "前往授权页",
    severity: "blocker",
  },
  ROUTE_ENDPOINTS_UNCONFIRMED: {
    title: "尚未选择路线端点",
    detail: "路线研究需要先确定出发地与目的地。",
    ctaHint: "在下方卡片中选择两个有效地点",
    severity: "blocker",
  },
  MODE_NOT_CHOSEN: {
    title: "尚未选择交通方式",
    detail: "路线研究需要选择交通方式（步行 / 驾车 / 骑行）。",
    ctaHint: "在下方确认卡中选择交通方式",
    severity: "blocker",
  },
  // Quick orchestration — soft budget hint. Always optional; absence
  // never blocks research. The conversational setup card surfaces a
  // 3-field widget (amount / currency / cadence) so the owner can
  // declare one without leaving the chat.
  BUDGET_HINT_MISSING: {
    title: "本次预算（可选）",
    detail: "预算仅用于偏向供应商价格区间，不填也能正常研究。",
    ctaHint: "在下方填写预算金额与币种",
    severity: "warning",
  },
};

/**
 * Renders a list of codes as a stable, deterministic copy block. Order is
 * preserved so the user sees the same ordering on each refresh.
 */
export function renderMissingCodes(codes: readonly PersonalResearchMissingCode[]): string[] {
  return codes.map((code) => MISSING_COPY[code].title);
}

export interface ReadinessCopy {
  headline: string;
  body: string;
}

export function renderReadinessHeadline(
  readiness: PersonalResearchReadiness,
): ReadinessCopy {
  if (readiness === "READY") {
    return {
      headline: "准备就绪",
      body: "已具备发起研究的全部前置条件。点击「确认运行」开始。",
    };
  }
  if (readiness === "READY_WITH_WARNINGS") {
    return {
      headline: "准备就绪（有提示）",
      body: "本研究可以发起，但有若干软提示需要你留意。点击「继续运行」开始。",
    };
  }
  if (readiness === "NEEDS_PLACE_SELECTION") {
    return {
      headline: "需要先选择路线端点",
      body: "路线研究需要先确定出发地与目的地。请在下方卡片中选择。",
    };
  }
  return {
    headline: "发起研究前还需要补全资料",
    body: "下方列出缺失的项目；逐项补全后即可运行研究。",
  };
}

/**
 * Splits a list of codes into blockers / warnings using the severity tag on
 * each `MISSING_COPY` entry. Preserves input order in each output array.
 */
export function partitionMissingCodes(
  codes: readonly PersonalResearchMissingCode[],
): { blockers: PersonalResearchMissingCode[]; warnings: PersonalResearchMissingCode[] } {
  const blockers: PersonalResearchMissingCode[] = [];
  const warnings: PersonalResearchMissingCode[] = [];
  for (const code of codes) {
    if (MISSING_COPY[code].severity === "blocker") blockers.push(code);
    else warnings.push(code);
  }
  return { blockers, warnings };
}