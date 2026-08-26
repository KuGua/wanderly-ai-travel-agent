import type {
  ConversationTurnRequest,
  ConversationTurnAcceptedResponse,
  CreateThreadInput,
  CreateThreadResponse,
  OwnerConversationResponse,
  ProfileResponse,
  ThreadsResponse,
  TripsResponse,
  UpdateProfileInput,
  UpdateProfileResponse,
  LocationReferenceInput,
  LocationReferenceResponse,
  AgentRun,
  AgentStreamEvent,
} from "./contracts";

export interface TravelApi {
  getMyProfile(): Promise<ProfileResponse>;
  updateMyProfile(input: UpdateProfileInput): Promise<UpdateProfileResponse>;
  getTrips(): Promise<TripsResponse>;
  getLocationReference(input: LocationReferenceInput): Promise<LocationReferenceResponse>;
  getThreads(): Promise<ThreadsResponse>;
  createThread(input: CreateThreadInput): Promise<CreateThreadResponse>;
  getOwnerConversation(threadId: string): Promise<OwnerConversationResponse>;
  submitConversationTurn(threadId: string, input: ConversationTurnRequest): Promise<ConversationTurnAcceptedResponse>;
  getAgentRun(runId: string): Promise<AgentRun>;
  cancelAgentRun(runId: string): Promise<AgentRun>;
  subscribeAgentRun(runId: string, signal: AbortSignal, onEvent: (event: AgentStreamEvent) => void): Promise<void>;
}
