import { pinoInstance } from "../observability/telemetry.js";

/**
 * Reads why a supplier rejected our request, for the 4xx responses that are
 * almost always our fault rather than the provider's.
 *
 * The adapters used to answer `UPSTREAM_FAILURE` on any `!response.ok` and
 * throw the body away unread. That is the wrong shape twice over: it blames
 * the supplier for a request we malformed, and it discards the one piece of
 * information that says which parameter was wrong. A SerpApi flight search
 * returned `400` repeatedly on 2026-09-05 and nothing in the logs could say
 * why, because this body was never read.
 *
 * Only known message fields are extracted, never the whole body: a supplier
 * error can quote the request back, and our API key travels in the query
 * string. The result is redacted and truncated before it reaches a log.
 */

const MAX_MESSAGE_CHARS = 300;
const MAX_BODY_BYTES = 8_192;
/** Query-string secrets a supplier may echo. Replaced before logging. */
const SECRET_PARAM = /\b(api_?key|apikey|token|access_token|key)=[^&\s"']+/gi;

/** The field names SerpApi, FlightAPI and Google-shaped errors actually use. */
const MESSAGE_FIELDS = ["error", "message", "detail", "error_message"] as const;

export function redactProviderMessage(raw: string): string {
  return raw.replace(SECRET_PARAM, "$1=[REDACTED]").slice(0, MAX_MESSAGE_CHARS);
}

function extractMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      for (const field of MESSAGE_FIELDS) {
        const value = (parsed as Record<string, unknown>)[field];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  } catch {
    // Not JSON. Fall through to the raw text, which is still bounded and
    // redacted below — an HTML error page truncates to something useless but
    // harmless, which beats logging nothing at all.
  }
  const text = body.trim();
  return text ? text : undefined;
}

/**
 * Logs the supplier's own explanation for a rejected request. Never throws:
 * a diagnostic must not turn a handled provider failure into an exception.
 */
export async function logProviderRejection(
  response: Response,
  context: { provider: string; operation: string },
): Promise<void> {
  let message: string | undefined;
  try {
    // `.clone()` so a caller that still wants the body is not left with a
    // consumed stream.
    const body = (await response.clone().text()).slice(0, MAX_BODY_BYTES);
    message = extractMessage(body);
  } catch {
    // A body that cannot be read is not worth failing the request over.
  }
  try {
    pinoInstance.warn({
      component: "provider-request-rejected",
      provider: context.provider,
      operation: context.operation,
      httpStatus: response.status,
      providerMessage: message ? redactProviderMessage(message) : undefined,
    }, "Provider rejected the request");
  } catch {
    // Diagnostics must never replace the failure being reported.
  }
}
