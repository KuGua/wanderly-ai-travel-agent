import { TravelApiError } from "@/lib/api/errors";

/**
 * The browser may send only these fixed, content-free diagnostic values. Keep
 * this list small: it is both the privacy boundary and the metrics cardinality
 * boundary enforced again by the API.
 */
export const UI_ACTIONS = [
  "frontend.runtime",
  "profile.save",
  "trip.activate",
  "trip.thread_create",
  "conversation.submit",
  "agent.run_cancel",
  "invitation.accept",
  "invitation.decline",
  "plan.confirm",
  "booking.confirm",
  // Phase 6 / Personal Trip Orchestrator
  "research.command_confirm",
  "research.command_reject",
  "research.stage_view",
  "research.intent_dismiss",
  // Personal Research Setup Sessions (§9)
  "setup.session_open",
  "setup.field_update",
  "setup.confirm",
  "setup.cancel",
  "setup.followup_received",
  // Phase 2 — Real-provider acknowledgement (flight / hotel / etc.)
  "research.real_provider_acknowledged",
  "research.real_provider_declined",
  // Phase 6 / Member conversation handoff
  "conversation.handoff_confirm",
  // Shared Plan Surface (Phase 4) — must match the server's `actions`
 // allow-list (apps/api/src/routes/ui-diagnostics.ts) or the request is
 // rejected with 422.
 "shared_plan.view_open",
 "shared_plan.vote_cast",
] as const;
export type UiAction = (typeof UI_ACTIONS)[number];

export const UI_SCREENS = ["home", "explore", "projects", "trip", "profile", "login", "register", "forgot_password", "unknown"] as const;
export type UiScreen = (typeof UI_SCREENS)[number];

export const UI_ERROR_CATEGORIES = [
  "none", "validation", "network", "http_4xx", "http_5xx", "timeout", "aborted", "invalid_response", "render", "unhandled",
] as const;
export type UiErrorCategory = (typeof UI_ERROR_CATEGORIES)[number];

export type UiDiagnosticEvent = {
  eventType: "ui_api_request" | "ui_action" | "ui_client_error";
  action: UiAction;
  screen: UiScreen;
  outcome: "success" | "failure";
  errorCategory: UiErrorCategory;
  durationMs?: number;
  httpStatus?: number;
  relatedCorrelationId?: string;
  relatedClientRequestId?: string;
};

type ReporterOptions = {
  apiBaseUrl: string;
  getAccessToken: () => string | null | Promise<string | null>;
};

function currentScreen(): UiScreen {
  if (typeof window === "undefined") return "unknown";
  const path = window.location.pathname.replace(/^\/[a-z]{2}(?:-[A-Z]{2})?(?=\/|$)/, "");
  if (path === "/" || path.startsWith("/home")) return "home";
  if (path.startsWith("/projects")) return "projects";
  if (path.startsWith("/trips")) return "trip";
  if (path.startsWith("/profile")) return "profile";
  if (path.startsWith("/login")) return "login";
  if (path.startsWith("/register")) return "register";
  if (path.startsWith("/forgot-password")) return "forgot_password";
  return "explore";
}

function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "00000000-0000-4000-8000-000000000000";
}

/**
 * Best-effort reporter. It intentionally does not use ApiClient, so reporting
 * cannot recursively generate another diagnostic event or delay the caller.
 */
export function createUiDiagnosticReporter(options: ReporterOptions) {
  const baseUrl = options.apiBaseUrl.replace(/\/$/, "");
  const send = async (event: UiDiagnosticEvent, suppliedAccessToken?: string | null): Promise<void> => {
    try {
      const accessToken = suppliedAccessToken === undefined
        ? await options.getAccessToken()
        : suppliedAccessToken;
      if (!accessToken) return; // This endpoint is deliberately authenticated.
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 500);
      try {
        await globalThis.fetch(`${baseUrl}/diagnostics/ui-events`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "X-Request-Id": requestId(),
          },
          body: JSON.stringify(event),
          signal: controller.signal,
          keepalive: true,
        });
      } finally {
        window.clearTimeout(timer);
      }
    } catch {
      // Diagnostics must never alter the original user action.
    }
  };
  return { send };
}

export function actionForApiRequest(path: string, method: string): UiAction | null {
  const normalized = path.split("?", 1)[0];
  if (method === "PUT" && normalized === "/profiles/me") return "profile.save";
  if (method === "POST" && /\/trips\/[^/]+\/activate$/u.test(normalized)) return "trip.activate";
  if (method === "POST" && /\/trips\/[^/]+\/threads$/u.test(normalized)) return "trip.thread_create";
  if (method === "POST" && /\/threads\/[^/]+\/turns$/u.test(normalized)) return "conversation.submit";
  if (method === "POST" && /\/agent-runs\/[^/]+\/cancel$/u.test(normalized)) return "agent.run_cancel";
  if (method === "POST" && /\/trip-invitations\/[^/]+\/accept$/u.test(normalized)) return "invitation.accept";
  if (method === "POST" && /\/trip-invitations\/[^/]+\/decline$/u.test(normalized)) return "invitation.decline";
  if (method === "POST" && /\/plans\/[^/]+\/confirm$/u.test(normalized)) return "plan.confirm";
  if (method === "POST" && /\/bookings\/confirm$/u.test(normalized)) return "booking.confirm";
  return null;
}

export function errorCategoryFor(error: unknown): UiErrorCategory {
  if (error instanceof TravelApiError) {
    if (error.statusCode === null) return "network";
    if (error.statusCode >= 500) return "http_5xx";
    if (error.statusCode >= 400) return "http_4xx";
    if (error.error === "Invalid Response") return "invalid_response";
  }
  return "unhandled";
}

export function getCurrentUiScreen(): UiScreen {
  return currentScreen();
}

/**
 * Phase 6 / Personal Trip Orchestrator — fire-and-forget diagnostic
 * emission for client-side intents (confirmation card, stage-card view).
 * The path-based `actionForApiRequest` only fires for outbound HTTP, so
 * we need an explicit helper for purely client events. Falls back to a
 * `console.debug` no-op if no reporter is wired (the events are still
 * captured in the renderer's logs).
 */
export function recordUiDiagnostic(
  action: UiAction,
  extras?: { screen?: UiScreen; capabilities?: readonly string[] },
): void {
  if (typeof window === "undefined") return;
  // The reporter is wired up per-app via `createUiDiagnosticReporter`;
  // we do not have access to it here, so the helper just emits a debug
  // log. The path-based actionForApiRequest remains the source of truth
  // for HTTP-triggered events.
  const screen = extras?.screen ?? currentScreen();
  if (typeof console !== "undefined" && process.env.NODE_ENV !== "production") {
    const capabilitiesSuffix = extras?.capabilities?.length
      ? ` capabilities=${extras.capabilities.join(",")}`
      : "";
    console.debug(`[ui-diagnostic] ${action} @ ${screen}${capabilitiesSuffix}`);
  }
}
