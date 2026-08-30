import type {
  ConversationTurnRequest,
  ConversationTurnAcceptedResponse,
  CreateThreadResponse,
  CreateTripThreadInput,
  OwnerConversationResponse,
  ProfileResponse,
  ThreadsResponse,
  TripDetailResponse,
  TripsResponse,
  UpdateProfileInput,
  UpdateProfileResponse,
  LocationReferenceInput,
  LocationReferenceResponse,
  LocationIntroductionInput,
  LocationIntroductionResponse,
  AgentRun,
  AgentStreamEvent,
  ExplorationStartRequest,
  ExplorationStartResponse,
  TripActivationRequest,
  TripActivationResponse,
  UpdateTripTitleInput,
  UpdateTripTitleResponse,
  UpdateDraftTripBriefInput,
  UpdateDraftTripBriefResponse,
  TripSearchPreferencesInput,
  TripSearchPreferencesResponse,
  PlanningTaskAcceptedResponse,
  LatestPlanResponse,
  LatestPlanningRunResponse,
} from "./contracts";

export interface TravelApi {
  getMyProfile(): Promise<ProfileResponse>;
  updateMyProfile(input: UpdateProfileInput): Promise<UpdateProfileResponse>;
  getTrips(): Promise<TripsResponse>;
  getTrip(tripId: string): Promise<TripDetailResponse>;
  getLocationReference(input: LocationReferenceInput): Promise<LocationReferenceResponse>;
  getLocationIntroduction(input: LocationIntroductionInput, options?: { signal?: AbortSignal }): Promise<LocationIntroductionResponse>;
  getTripThreads(tripId: string): Promise<ThreadsResponse>;
  createTripThread(tripId: string, input: CreateTripThreadInput): Promise<CreateThreadResponse>;
  getOrCreateDefaultTripThread(tripId: string): Promise<CreateThreadResponse>;
  getOwnerConversation(threadId: string): Promise<OwnerConversationResponse>;
  submitConversationTurn(threadId: string, input: ConversationTurnRequest): Promise<ConversationTurnAcceptedResponse>;
  getAgentRun(runId: string): Promise<AgentRun>;
  cancelAgentRun(runId: string): Promise<AgentRun>;
  subscribeAgentRun(runId: string, signal: AbortSignal, onEvent: (event: AgentStreamEvent) => void): Promise<void>;
  startExploration(input: ExplorationStartRequest): Promise<ExplorationStartResponse>;
  activateTrip(tripId: string, input: TripActivationRequest): Promise<TripActivationResponse>;
  updateTripTitle(tripId: string, input: UpdateTripTitleInput): Promise<UpdateTripTitleResponse>;
  updateDraftTripBrief?(tripId: string, input: UpdateDraftTripBriefInput): Promise<UpdateDraftTripBriefResponse>;
  saveTripSearchPreferences(tripId: string, input: TripSearchPreferencesInput): Promise<TripSearchPreferencesResponse>;
  startPlanning(tripId: string): Promise<PlanningTaskAcceptedResponse>;
  getLatestPlanningRun(tripId: string): Promise<LatestPlanningRunResponse>;
  getLatestPlan(tripId: string): Promise<LatestPlanResponse>;
}
