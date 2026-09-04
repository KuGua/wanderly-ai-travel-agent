import type {
  ConversationTurnRequest,
  ConversationTurnAcceptedResponse,
  CreateThreadResponse,
  CreateTripThreadInput,
  OwnerConversationResponse,
  PersonalResearchAnswersRequest,
  PersonalResearchConfirmAcceptedResponse,
  PersonalResearchConfirmRequest,
  PersonalResearchReadResponse,
  ProfileResponse,
  RenameThreadInput,
  SuggestThreadTitleInput,
  SuggestThreadTitleResponse,
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
  TripConstraintProposal,
  TripConstraintsResponse,
  TripConstraintsOwnerResponse,
  TripConstraintProposalsResponse,
  CreateTripConstraintProposalRequest,
  ConfirmTripConstraintProposalRequest,
  UpsertTripConstraintFactRequest,
  ConfirmProposalResponse,
  UpsertFactResponse,
  CastAdoptionVoteRequest,
  AdoptionVoteResponse,
  AdoptionVoteListResponse,
  TripPlansListResponse,
  ConstraintHandoffBatchResponse,
  ConstraintHandoffConfirmRequest,
  ConstraintHandoffConfirmResponse,
  TripPlacesResponse,
  PlaceCandidateSearchRequest,
  PlaceCandidateSearchResponse,
  ProposeTripPlaceRequest,
  AdoptTripPlaceRequest,
  RevokeTripPlaceRequest,
  TripPlaceActionResponse,
  MemoryFact,
  ProfileMemoryResponse,
  ResolveProposalResponse,
  UpdateMemoryFactInput,
  TripMemoryFact,
  TripMemoryGroupResponse,
  TripMemoryOverridesResponse,
  RouteEvidenceList,
  NavigationRouteSearchRequest,
  NavigationRouteSearchResponse,
  MobilityOfferList,
  MobilitySearchRequest,
  MobilitySearchResponse,
  MobilityOfferSelectionRequest,
  MobilityOfferSelectionResponse,
  InvitationPreviewResponse,
  AcceptInvitationResponse,
  DeclineInvitationResponse,
  CreateTripInvitationInput,
  TripInvitationCreateResponse,
  ResearchCommandRequest,
  ResearchCommandAcceptedResponse,
  LatestResearchResultResponse,
  SoloAdoptPlanResponse,
} from "./contracts";

export interface TravelApi {
  getMyProfile(): Promise<ProfileResponse>;
  updateMyProfile(input: UpdateProfileInput): Promise<UpdateProfileResponse>;
  getPreferenceCard(tripId: string): Promise<import("./contracts").PreferenceCard>;
  resolvePreferenceCard(tripId: string, adjustments: Array<{ fieldKey: string; value: unknown }>): Promise<{ applied: string[] }>;
  rememberHighlight(input: {
    highlight: string;
    sourceThreadId?: string | null;
    sourceMessageId?: string | null;
  }): Promise<import("./contracts").RememberHighlightResponse>;
  getMemoryNotes(): Promise<import("./contracts").MemoryNotesResponse>;
  deleteMemoryNote(noteId: string): Promise<void>;
  getProfileMemory(): Promise<ProfileMemoryResponse>;
  updateMemoryFact(factId: string, input: UpdateMemoryFactInput): Promise<MemoryFact>;
  deleteMemoryFact(factId: string): Promise<void>;
  confirmMemoryProposal(proposalId: string): Promise<ResolveProposalResponse>;
  dismissMemoryProposal(proposalId: string): Promise<ResolveProposalResponse>;
  getTripMemoryOverrides(tripId: string): Promise<TripMemoryOverridesResponse>;
  getTripMemoryGroupDecisions(tripId: string): Promise<TripMemoryGroupResponse>;
  saveTripMemoryOverride(tripId: string, fieldKey: string, value: unknown): Promise<TripMemoryFact>;
  saveTripMemoryGroupDecision(tripId: string, fieldKey: string, value: unknown): Promise<TripMemoryFact>;
  deleteTripMemory(tripId: string, factId: string): Promise<void>;
  getTrips(): Promise<TripsResponse>;
  getTrip(tripId: string): Promise<TripDetailResponse>;
  // Optional while older fixtures and API adapters adopt the invitation flow.
  getInvitationPreview?(inviteToken: string): Promise<InvitationPreviewResponse>;
  acceptInvitation?(inviteToken: string): Promise<AcceptInvitationResponse>;
  declineInvitation?(inviteToken: string): Promise<DeclineInvitationResponse>;
  createTripInvitation?(tripId: string, input: CreateTripInvitationInput): Promise<TripInvitationCreateResponse>;
  getLocationReference(input: LocationReferenceInput): Promise<LocationReferenceResponse>;
  getLocationIntroduction(input: LocationIntroductionInput, options?: { signal?: AbortSignal }): Promise<LocationIntroductionResponse>;
  getTripThreads(tripId: string): Promise<ThreadsResponse>;
  createTripThread(tripId: string, input: CreateTripThreadInput): Promise<CreateThreadResponse>;
  getOrCreateDefaultTripThread(tripId: string): Promise<CreateThreadResponse>;
  // Optional so unrelated test mocks don't have to stub them; the real
  // HttpTravelApi implements both.
  renameThread?(tripId: string, threadId: string, input: RenameThreadInput): Promise<CreateThreadResponse>;
  suggestThreadTitle?(tripId: string, threadId: string, input: SuggestThreadTitleInput): Promise<SuggestThreadTitleResponse>;
  getOwnerConversation(threadId: string): Promise<OwnerConversationResponse>;
  submitConversationTurn(threadId: string, input: ConversationTurnRequest): Promise<ConversationTurnAcceptedResponse>;
  getAgentRun(runId: string): Promise<AgentRun>;
  cancelAgentRun(runId: string): Promise<AgentRun>;
  dismissResearchIntent?(runId: string): Promise<void>;
  // Personal Research Setup Sessions (§9) — owner-only conversational
  // completion flow. Optional in the interface so older test mocks and
  // partial adapters degrade gracefully.
  // Setup-session methods (getResearchSetup / openResearchSetup /
// saveResearchSetupAnswer / cancelResearchSetup / confirmResearchSetup) were
// removed with the conversational setup pipeline (migration 0049). LLM-driven
// tool calling (Phase 4) drives the same flow inline via chat history.
  getRouteEndpoints?(tripId: string): Promise<Array<{ placeId: string; displayName: string }>>;
  saveRouteSelection?(runId: string, input: { originPlaceId: string; destinationPlaceId: string; mode: "WALK" | "DRIVE" | "CYCLE" }): Promise<void>;
  // DRAFT Personal Research (docs/draft-personal-research-implementation.md) —
  // owner-only typed-draft + durable-task surface for DRAFT trip research.
  // Optional in the interface so older fixtures and partial adapters degrade.
  getPersonalResearch?(runId: string): Promise<PersonalResearchReadResponse>;
  savePersonalResearchAnswers?(runId: string, input: PersonalResearchAnswersRequest): Promise<void>;
  confirmPersonalResearch?(runId: string, input: PersonalResearchConfirmRequest): Promise<PersonalResearchConfirmAcceptedResponse>;
  cancelPersonalResearch?(runId: string): Promise<PersonalResearchReadResponse>;
  subscribeAgentRun(runId: string, signal: AbortSignal, onEvent: (event: AgentStreamEvent) => void): Promise<void>;
  startExploration(input: ExplorationStartRequest): Promise<ExplorationStartResponse>;
  activateTrip(tripId: string, input: TripActivationRequest): Promise<TripActivationResponse>;
  updateTripTitle(tripId: string, input: UpdateTripTitleInput): Promise<UpdateTripTitleResponse>;
  /** Optional so existing test doubles keep compiling without a stub. */
  deleteTrip?(tripId: string): Promise<void>;
  updateDraftTripBrief?(tripId: string, input: UpdateDraftTripBriefInput): Promise<UpdateDraftTripBriefResponse>;
  saveTripSearchPreferences(tripId: string, input: TripSearchPreferencesInput): Promise<TripSearchPreferencesResponse>;
  startPlanning(tripId: string): Promise<PlanningTaskAcceptedResponse>;
  getLatestPlanningRun(tripId: string): Promise<LatestPlanningRunResponse>;
  getLatestPlan(tripId: string): Promise<LatestPlanResponse>;

  // ── Team Agent 协作编排 (Phase 5) ────────────────────────────────────────────
  // These are intentionally optional so existing partial mocks and consumers
  // can adopt them incrementally without touching the entire test suite.
  createConstraintProposal?(tripId: string, input: CreateTripConstraintProposalRequest, options?: { idempotencyKey?: string }): Promise<TripConstraintProposal>;
  listMyConstraintProposals?(tripId: string): Promise<TripConstraintProposalsResponse>;
  confirmConstraintProposal?(tripId: string, proposalId: string, input: ConfirmTripConstraintProposalRequest, options?: { idempotencyKey?: string }): Promise<ConfirmProposalResponse>;
  dismissConstraintProposal?(tripId: string, proposalId: string, options?: { idempotencyKey?: string }): Promise<{ dismissed: true; proposalId: string }>;
  upsertConstraintFact?(tripId: string, factId: string, input: UpsertTripConstraintFactRequest, options?: { idempotencyKey?: string }): Promise<UpsertFactResponse>;
  revokeConstraintFact?(tripId: string, factId: string, options?: { idempotencyKey?: string }): Promise<UpsertFactResponse>;
  listConstraintsForMembers?(tripId: string): Promise<TripConstraintsResponse>;
  listConstraintsForOwner?(tripId: string): Promise<TripConstraintsOwnerResponse>;
  // Shared Plan Surface (Phase 5) — required. The shared view hard-depends
  // on these three; making them optional invites a silent empty state when
  // a partial mock forgets to stub them. Bump the whole interface up to
  // required so the dependency is visible at compile time. docs/shared-plan-surface-implementation.md §3.2 M2.
  castAdoptionVote(planId: string, input: CastAdoptionVoteRequest, options?: { idempotencyKey?: string }): Promise<AdoptionVoteResponse>;
  listAdoptionVotes(planId: string): Promise<AdoptionVoteListResponse>;
  listTripPlans(tripId: string): Promise<TripPlansListResponse>;

  // ── Member conversation handoff (Phase 6) ─────────────────────────────────
  // Candidate batch read + batch confirm. The candidate card pulls
  // `getConstraintHandoffBatch`; the confirm action submits the trimmed
  // payload (proposalId + visibility + strength per row) so the server
  // remains the only authority on what becomes a fact.
  getConstraintHandoffBatch?(tripId: string, batchId: string): Promise<ConstraintHandoffBatchResponse>;
  confirmConstraintHandoffBatch?(tripId: string, batchId: string, input: ConstraintHandoffConfirmRequest, options?: { idempotencyKey?: string }): Promise<ConstraintHandoffConfirmResponse>;

  // ── Global POI & ground mobility (Phase 2) ──────────────────────────────────
  // Optional methods to preserve Phase-5 style incremental adoption. The web
  // calls each behind `enabled: !!api.<method>` to avoid breaking older mocks.
  listTripPlaces?(tripId: string): Promise<TripPlacesResponse>;
  searchPlaceCandidates?(tripId: string, input: PlaceCandidateSearchRequest, options?: { idempotencyKey?: string }): Promise<PlaceCandidateSearchResponse>;
  proposeTripPlace?(tripId: string, input: ProposeTripPlaceRequest, options?: { idempotencyKey?: string }): Promise<TripPlaceActionResponse>;
  adoptTripPlace?(tripId: string, input: AdoptTripPlaceRequest, options?: { idempotencyKey?: string }): Promise<TripPlaceActionResponse>;
  revokeTripPlace?(tripId: string, input: RevokeTripPlaceRequest, options?: { idempotencyKey?: string }): Promise<TripPlaceActionResponse>;

  // ── Phase 3 navigation route evidence ────────────────────────────────────────
  listRouteEvidence?(tripId: string, planId?: string): Promise<RouteEvidenceList>;
  searchRoute?(tripId: string, planId: string, input: NavigationRouteSearchRequest, options?: { idempotencyKey?: string }): Promise<NavigationRouteSearchResponse>;

  // ── Phase 5 mobility offers (Amadeus Transfer Search) ────────────────────────
  listMobilityOffers?(tripId: string): Promise<MobilityOfferList>;
  searchMobilityOffers?(tripId: string, input: MobilitySearchRequest, options?: { idempotencyKey?: string }): Promise<MobilitySearchResponse>;
  selectMobilityOffer?(tripId: string, input: MobilityOfferSelectionRequest, options?: { idempotencyKey?: string }): Promise<MobilityOfferSelectionResponse>;

  // ── Phase 6 / Personal Trip Orchestrator ────────────────────────────────────
  postResearchCommand?(tripId: string, input: ResearchCommandRequest, options?: { idempotencyKey?: string }): Promise<ResearchCommandAcceptedResponse>;
  getLatestResearchResult?(tripId: string): Promise<LatestResearchResultResponse>;
  acceptSoloPlan?(planId: string, options?: { idempotencyKey?: string }): Promise<SoloAdoptPlanResponse>;
}
