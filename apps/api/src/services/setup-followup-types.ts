/**
 * Type contracts for the setup-followup generator. Kept in a separate
 * file so the generator can be imported without pulling in
 * `providers/model-gateway` (and triggering its column-type cycle).
 */

export type SetupFollowupSource = "model" | "fallback";

export type SetupFollowupQuestionCode =
  | "TRIP_NOT_ACTIVE"
  | "DESTINATION_NOT_CONFIGURED"
  | "DATES_MISSING"
  | "FLIGHT_PREFERENCES_MISSING"
  | "STAY_PREFERENCES_MISSING"
  | "HOTEL_PROVIDER_NOT_APPROVED"
  | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING"
  | "ROUTE_ENDPOINTS_UNCONFIRMED"
  | "MODE_NOT_CHOSEN";

export interface SetupFollowupResult {
  questionCode: string;
  promptText: string;
  modelName: string;
  promptVersion: string;
}

export interface ConversationFollowupFallback {
  questionCode: string;
  promptText: string;
  source: SetupFollowupSource;
}
