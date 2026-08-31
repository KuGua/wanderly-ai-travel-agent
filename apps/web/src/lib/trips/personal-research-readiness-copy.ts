/**
 * Personal Research Intent — readiness copy table (Phase 2).
 *
 * Maps the server-stable `missing[]` codes returned in the persisted
 * draft to user-facing Chinese copy. The server contract uses raw codes
 * (per docs/personal-research-intent-routing-implementation.md §4.2) so
 * a downstream string change never breaks the wire format; this lookup
 * is the single client-side translation point.
 *
 * Add a new entry here (and a matching copy under `MISSING_COPY`) when
 * the server introduces a new `researchMissingCodeSchema` value. NEVER
 * embed the original question, a place name, or any identifier here —
 * the card body is rendered into the DOM and any leakage becomes
 * recoverable audit data.
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
  | "MODE_NOT_CHOSEN";

export type PersonalResearchReadiness =
  | "READY"
  | "NEEDS_SETUP"
  | "NEEDS_PLACE_SELECTION";

export interface MissingCodeCopy {
  title: string;
  detail: string;
  ctaHint: string;
}

export const MISSING_COPY: Record<PersonalResearchMissingCode, MissingCodeCopy> = {
  TRIP_NOT_ACTIVE: {
    title: "行程尚未激活",
    detail: "本次研究只能在已激活的行程上发起。请先在行程页激活 Trip。",
    ctaHint: "前往行程页",
  },
  DESTINATION_NOT_CONFIGURED: {
    title: "尚未选择目的地",
    detail: "研究需要先确定目的地。",
    ctaHint: "在行程页填写目的地",
  },
  DATES_MISSING: {
    title: "尚未填写出行日期",
    detail: "酒店与活动研究依赖出行日期。",
    ctaHint: "在行程页填写出发与返回日期",
  },
  FLIGHT_PREFERENCES_MISSING: {
    title: "尚未确认航班偏好",
    detail: "本次研究包含航班能力，请先在偏好页确认舱位 / 人数 / 货币。",
    ctaHint: "前往偏好页",
  },
  STAY_PREFERENCES_MISSING: {
    title: "尚未确认住宿偏好",
    detail: "酒店研究依赖住宿偏好（房间数 / 成人 / 货币）。",
    ctaHint: "前往偏好页",
  },
  HOTEL_PROVIDER_NOT_APPROVED: {
    title: "酒店供应商未启用",
    detail: "当前环境未启用酒店供应商；请稍后再试或联系运维。",
    ctaHint: "联系运维",
  },
  QUOTE_NATIONALITY_AUTHORIZATION_MISSING: {
    title: "Nuitee 国籍授权缺失",
    detail: "酒店供应商需要有效的国籍授权，请先在授权页完成确认。",
    ctaHint: "前往授权页",
  },
  ROUTE_ENDPOINTS_UNCONFIRMED: {
    title: "尚未选择路线端点",
    detail: "路线研究需要先确定出发地与目的地。",
    ctaHint: "在下方卡片中选择两个有效地点",
  },
  MODE_NOT_CHOSEN: {
    title: "尚未选择交通方式",
    detail: "路线研究需要选择交通方式（步行 / 驾车 / 骑行）。",
    ctaHint: "在下方确认卡中选择交通方式",
  },
};

/**
 * Renders a list of `missing[]` codes as a stable, deterministic copy
 * block. Order is preserved — the server returns codes in a stable
 * order so the user sees the same ordering on each refresh.
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
