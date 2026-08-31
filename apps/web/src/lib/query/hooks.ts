"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ConversationTurnRequest,
  ConversationTurnAcceptedResponse,
  CreateTripThreadInput,
  OwnerConversationResponse,
  ThreadsResponse,
  TripActivationRequest,
  TripSearchPreferencesInput,
  UpdateProfileInput,
  CastAdoptionVoteRequest,
  ConfirmTripConstraintProposalRequest,
  CreateTripConstraintProposalRequest,
  UpsertTripConstraintFactRequest,
  AdoptTripPlaceRequest,
  PlaceCandidateSearchRequest,
  ProposeTripPlaceRequest,
  RevokeTripPlaceRequest,
  NavigationRouteSearchRequest,
  MobilitySearchRequest,
  MobilityOfferSelectionRequest,
} from "@/lib/api/contracts";
import { useTravelApi } from "./provider";
import { profileKeys, threadKeys, tripKeys, teamOrchestrationKeys, invitationKeys, personalOrchestrationKeys } from "./keys";

export function useMyProfile() {
  const api = useTravelApi();
  return useQuery({
    queryKey: profileKeys.me,
    queryFn: () => api.getMyProfile(),
  });
}

/**
 * The owner's long-term memory: confirmed facts plus any suggestion that has
 * cleared the server-side trigger rule.
 */
export function useProfileMemory() {
  const api = useTravelApi();
  return useQuery({
    queryKey: profileKeys.memory,
    queryFn: () => api.getProfileMemory(),
  });
}

/**
 * Every memory mutation invalidates the whole memory query rather than
 * patching the cache. Confirming or editing one field can clear suggestions
 * for it server-side, so a local patch would leave stale cards on screen.
 */
function useMemoryMutation<TArgs>(mutationFn: (args: TArgs) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profileKeys.memory });
    },
  });
}

export function useUpdateMemoryFact() {
  const api = useTravelApi();
  return useMemoryMutation(({ factId, value }: { factId: string; value: unknown }) =>
    api.updateMemoryFact(factId, { value }));
}

export function useDeleteMemoryFact() {
  const api = useTravelApi();
  return useMemoryMutation((factId: string) => api.deleteMemoryFact(factId));
}

export function useConfirmMemoryProposal() {
  const api = useTravelApi();
  return useMemoryMutation((proposalId: string) => api.confirmMemoryProposal(proposalId));
}

export function useDismissMemoryProposal() {
  const api = useTravelApi();
  return useMemoryMutation((proposalId: string) => api.dismissMemoryProposal(proposalId));
}

/** The caller's own "this trip" preferences. Never another member's. */
export function useTripMemoryOverrides(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: tripKeys.memoryOverrides(tripId),
    queryFn: () => api.getTripMemoryOverrides(tripId),
  });
}

/** Group decisions, visible to every active member of the trip. */
export function useTripMemoryGroupDecisions(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: tripKeys.memoryGroup(tripId),
    queryFn: () => api.getTripMemoryGroupDecisions(tripId),
  });
}

/**
 * Saving trip memory stales the trip's active plan server-side, so both memory
 * lists and the trip detail are invalidated rather than patched locally.
 */
function useTripMemoryMutation<TArgs>(tripId: string, mutationFn: (args: TArgs) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: tripKeys.memoryOverrides(tripId) }),
        queryClient.invalidateQueries({ queryKey: tripKeys.memoryGroup(tripId) }),
        queryClient.invalidateQueries({ queryKey: tripKeys.detail(tripId) }),
      ]);
    },
  });
}

export function useSaveTripMemoryOverride(tripId: string) {
  const api = useTravelApi();
  return useTripMemoryMutation(tripId, ({ fieldKey, value }: { fieldKey: string; value: unknown }) =>
    api.saveTripMemoryOverride(tripId, fieldKey, value));
}

export function useSaveTripMemoryGroupDecision(tripId: string) {
  const api = useTravelApi();
  return useTripMemoryMutation(tripId, ({ fieldKey, value }: { fieldKey: string; value: unknown }) =>
    api.saveTripMemoryGroupDecision(tripId, fieldKey, value));
}

export function useDeleteTripMemory(tripId: string) {
  const api = useTravelApi();
  return useTripMemoryMutation(tripId, (factId: string) => api.deleteTripMemory(tripId, factId));
}

export function useTrips() {
  const api = useTravelApi();
  return useQuery({
    queryKey: tripKeys.list,
    queryFn: () => api.getTrips(),
  });
}

export function useTrip(tripId: string | null) {
  const api = useTravelApi();
  return useQuery({
    queryKey: tripKeys.detail(tripId ?? "none"),
    queryFn: () => api.getTrip(tripId as string),
    enabled: Boolean(tripId),
    retry: false,
  });
}

export function useInvitationPreview(inviteToken: string | null) {
  const api = useTravelApi();
  return useQuery({
    queryKey: invitationKeys.preview(inviteToken ?? "none"),
    queryFn: () => api.getInvitationPreview!(inviteToken as string),
    enabled: Boolean(inviteToken) && !!api.getInvitationPreview,
    retry: false,
  });
}

export function useAcceptInvitation() {
  const api = useTravelApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteToken: string) => api.acceptInvitation!(inviteToken),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: tripKeys.all }); },
  });
}

export function useDeclineInvitation() {
  const api = useTravelApi();
  return useMutation({ mutationFn: (inviteToken: string) => api.declineInvitation!(inviteToken) });
}

export function useCreateTripInvitation(tripId: string) {
  const api = useTravelApi();
  return useMutation({
    mutationFn: (input: import("../api/contracts").CreateTripInvitationInput) =>
      api.createTripInvitation!(tripId, input),
  });
}

export function useTripThreads(tripId: string | null) {
  const api = useTravelApi();
  return useQuery({
    queryKey: tripKeys.threads(tripId ?? "none"),
    queryFn: () => api.getTripThreads(tripId as string),
    enabled: Boolean(tripId),
    retry: false,
  });
}

export function useUpdateMyProfile() {
  const api = useTravelApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateProfileInput) => api.updateMyProfile(input),
    onSuccess: ({ profile }) => {
      queryClient.setQueryData(profileKeys.me, { profile });
    },
  });
}

export function useOwnerConversation(threadId: string | null) {
  const api = useTravelApi();
  return useQuery({
    queryKey: threadKeys.conversation(threadId ?? "none"),
    queryFn: () => api.getOwnerConversation(threadId!),
    enabled: Boolean(threadId),
    retry: false,
  });
}

export function useCreateTripThread(tripId: string) {
  const api = useTravelApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTripThreadInput) => api.createTripThread(tripId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tripKeys.threads(tripId) });
    },
  });
}

export function useGetOrCreateDefaultTripThread(tripId: string) {
  const api = useTravelApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.getOrCreateDefaultTripThread(tripId),
    onSuccess: (thread) => {
      // The POST response is the authoritative persisted thread. Publish it
      // immediately so chat readiness does not depend on a second GET request
      // completing successfully after provisioning.
      queryClient.setQueryData<ThreadsResponse>(tripKeys.threads(tripId), (current) => ({
        threads: mergeThreads(current?.threads ?? [], [thread]),
      }));
    },
  });
}

export function useSubmitConversationTurn() {
  const api = useTravelApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ threadId, input }: { threadId: string; input: ConversationTurnRequest }) =>
      api.submitConversationTurn(threadId, input),
    onSuccess: (turn: ConversationTurnAcceptedResponse) => {
      queryClient.setQueryData<OwnerConversationResponse>(
        threadKeys.conversation(turn.threadId),
        (current) => current
          ? { ...current, messages: mergeConversationMessages(current.messages, [turn.userMessage]) }
          : current,
      );
    },
  });
}

export function useAgentRun(runId: string | null) {
  const api = useTravelApi();
  return useQuery({
    queryKey: ["agent-runs", runId ?? "none"],
    queryFn: () => api.getAgentRun(runId!),
    enabled: Boolean(runId),
    refetchInterval: 1_500,
    retry: false,
  });
}

export function useCancelAgentRun() {
  const api = useTravelApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelAgentRun(runId),
    onSuccess: (run) => {
      queryClient.setQueryData(["agent-runs", run.runId], run);
    },
  });
}

export function useActivateTrip(tripId: string) {
  const api = useTravelApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TripActivationRequest) => api.activateTrip(tripId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tripKeys.all });
      void queryClient.invalidateQueries({ queryKey: tripKeys.detail(tripId) });
    },
  });
}

export function useUpdateTripTitle(tripId: string) {
  const api = useTravelApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: import("../api/contracts").UpdateTripTitleInput) => api.updateTripTitle(tripId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tripKeys.all });
      void queryClient.invalidateQueries({ queryKey: tripKeys.detail(tripId) });
    },
  });
}

export function useLatestPlanningRun(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: tripKeys.planningRun(tripId),
    queryFn: () => api.getLatestPlanningRun(tripId),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      return status === "QUEUED" || status === "RUNNING" || status === "CANCEL_REQUESTED" ? 1_500 : false;
    },
  });
}

export function useLatestPlan(tripId: string, enabled: boolean) {
  const api = useTravelApi();
  return useQuery({
    queryKey: tripKeys.latestPlan(tripId),
    queryFn: () => api.getLatestPlan(tripId),
    enabled,
    retry: false,
  });
}

export function useStartPlanning(tripId: string) {
  const api = useTravelApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (preferences: TripSearchPreferencesInput) => {
      await api.saveTripSearchPreferences(tripId, preferences);
      return api.startPlanning(tripId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tripKeys.planningRun(tripId) });
    },
  });
}

/** Creator-only edits to the private Draft brief, before activation. */
export function useUpdateDraftTripBrief(tripId: string) {
  const api = useTravelApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: import("../api/contracts").UpdateDraftTripBriefInput) => {
      if (!api.updateDraftTripBrief) throw new Error("Draft brief updates are unavailable");
      return api.updateDraftTripBrief(tripId, input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tripKeys.all });
      void queryClient.invalidateQueries({ queryKey: tripKeys.detail(tripId) });
    },
  });
}

function mergeConversationMessages(
  current: OwnerConversationResponse["messages"],
  incoming: OwnerConversationResponse["messages"],
) {
  const messages = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => messages.set(message.id, message));
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence);
}

function mergeThreads(
  current: ThreadsResponse["threads"],
  incoming: ThreadsResponse["threads"],
) {
  const threads = new Map(current.map((thread) => [thread.id, thread]));
  incoming.forEach((thread) => threads.set(thread.id, thread));
  return [...threads.values()];
}

// ── Team Agent 协作编排 (Phase 5) ──────────────────────────────────────────

export function useMyConstraintProposals(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: teamOrchestrationKeys.proposals(tripId),
    queryFn: () => api.listMyConstraintProposals!(tripId),
    enabled: !!api.listMyConstraintProposals,
  });
}

export function useCreateConstraintProposal(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTripConstraintProposalRequest) =>
      api.createConstraintProposal!(tripId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.proposals(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.constraintsOwner(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.constraintsMembers(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.plans(tripId) });
    },
  });
}

export function useConfirmConstraintProposal(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { proposalId: string; input: ConfirmTripConstraintProposalRequest }) =>
      api.confirmConstraintProposal!(tripId, params.proposalId, params.input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.proposals(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.constraintsOwner(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.constraintsMembers(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.plans(tripId) });
      qc.invalidateQueries({ queryKey: tripKeys.detail(tripId) });
    },
  });
}

export function useDismissConstraintProposal(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) =>
      api.dismissConstraintProposal!(tripId, proposalId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.proposals(tripId) });
    },
  });
}

export function useUpsertConstraintFact(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { factId: string; input: UpsertTripConstraintFactRequest }) =>
      api.upsertConstraintFact!(tripId, params.factId, params.input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.constraintsOwner(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.constraintsMembers(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.plans(tripId) });
      qc.invalidateQueries({ queryKey: tripKeys.detail(tripId) });
    },
  });
}

export function useRevokeConstraintFact(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (factId: string) => api.revokeConstraintFact!(tripId, factId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.constraintsOwner(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.constraintsMembers(tripId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.plans(tripId) });
      qc.invalidateQueries({ queryKey: tripKeys.detail(tripId) });
    },
  });
}

export function useTripConstraintsForMembers(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: teamOrchestrationKeys.constraintsMembers(tripId),
    queryFn: () => api.listConstraintsForMembers!(tripId),
    enabled: !!api.listConstraintsForMembers,
  });
}

export function useTripConstraintsForOwner(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: teamOrchestrationKeys.constraintsOwner(tripId),
    queryFn: () => api.listConstraintsForOwner!(tripId),
    enabled: !!api.listConstraintsForOwner,
  });
}

export function useTripPlans(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: teamOrchestrationKeys.plans(tripId),
    queryFn: () => api.listTripPlans!(tripId),
    enabled: !!api.listTripPlans,
  });
}

export function usePlanAdoptionVotes(planId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: teamOrchestrationKeys.votes(planId),
    queryFn: () => api.listAdoptionVotes!(planId),
    enabled: !!api.listAdoptionVotes,
  });
}

export function useCastAdoptionVote(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { planId: string; input: CastAdoptionVoteRequest }) =>
      api.castAdoptionVote!(params.planId, params.input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.votes(vars.planId) });
      qc.invalidateQueries({ queryKey: teamOrchestrationKeys.plans(tripId) });
    },
  });
}

// ─── Global POI & ground mobility (Phase 2) ────────────────────────────────────
// All hooks follow the `enabled: !!api.<method>` pattern so partial mocks
// from earlier phases don't break the new UI.
export function useTripPlaces(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: tripKeys.places(tripId),
    queryFn: () => api.listTripPlaces!(tripId),
    enabled: !!api.listTripPlaces,
  });
}

export function useResearchResult(tripId: string, agentTaskRunId?: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: [...tripKeys.researchResults(tripId), agentTaskRunId ?? "latest"],
    queryFn: () => api.getResearchResult!(tripId, agentTaskRunId),
    enabled: !!api.getResearchResult,
  });
}

// ── Phase 6 / Personal Trip Orchestrator ────────────────────────────────────
export function useLatestResearchResult(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: personalOrchestrationKeys.researchLatest(tripId),
    queryFn: () => api.getLatestResearchResult!(tripId),
    enabled: !!api.getLatestResearchResult,
  });
}

export function useConfirmResearchCommand(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: import("../api/contracts").ResearchCommandRequest) =>
      api.postResearchCommand!(tripId, input, { idempotencyKey: input.requestId }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: personalOrchestrationKeys.researchLatest(tripId) });
      qc.invalidateQueries({ queryKey: tripKeys.detail(tripId) });
      qc.invalidateQueries({ queryKey: tripKeys.researchResults(tripId) });
      void vars; // keep TS happy
    },
  });
}

export function useSoloAdoptPlan(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.acceptSoloPlan!(planId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: personalOrchestrationKeys.proposedPlans(tripId) });
      qc.invalidateQueries({ queryKey: tripKeys.detail(tripId) });
    },
  });
}

export function useRouteEvidence(tripId: string, planId?: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: [...tripKeys.routeEvidence(tripId, planId ?? "latest")],
    queryFn: () => api.listRouteEvidence!(tripId, planId),
    enabled: !!api.listRouteEvidence,
  });
}

export function useSearchRoute(tripId: string) {
  const api = useTravelApi();
  return useMutation({
    mutationFn: (params: { planId: string; input: NavigationRouteSearchRequest; idempotencyKey?: string }) =>
      api.searchRoute!(tripId, params.planId, params.input, { idempotencyKey: params.idempotencyKey }),
  });
}

export function useMobilityOffers(tripId: string) {
  const api = useTravelApi();
  return useQuery({
    queryKey: tripKeys.mobilityOffers(tripId),
    queryFn: () => api.listMobilityOffers!(tripId),
    enabled: !!api.listMobilityOffers,
  });
}

export function useSearchMobilityOffers(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { input: MobilitySearchRequest; idempotencyKey?: string }) =>
      api.searchMobilityOffers!(tripId, params.input, { idempotencyKey: params.idempotencyKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tripKeys.mobilityOffers(tripId) });
    },
  });
}

export function useSelectMobilityOffer(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { input: MobilityOfferSelectionRequest; idempotencyKey?: string }) =>
      api.selectMobilityOffer!(tripId, params.input, { idempotencyKey: params.idempotencyKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tripKeys.mobilityOffers(tripId) });
    },
  });
}

export function useSearchPlaceCandidates(tripId: string) {
  const api = useTravelApi();
  return useMutation({
    mutationFn: (params: { input: PlaceCandidateSearchRequest; idempotencyKey?: string }) =>
      api.searchPlaceCandidates!(tripId, params.input, { idempotencyKey: params.idempotencyKey }),
  });
}

export function useProposeTripPlace(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { input: ProposeTripPlaceRequest; idempotencyKey?: string }) =>
      api.proposeTripPlace!(tripId, params.input, { idempotencyKey: params.idempotencyKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tripKeys.places(tripId) });
    },
  });
}

export function useAdoptTripPlace(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { input: AdoptTripPlaceRequest; idempotencyKey?: string }) =>
      api.adoptTripPlace!(tripId, params.input, { idempotencyKey: params.idempotencyKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tripKeys.places(tripId) });
    },
  });
}

export function useRevokeTripPlace(tripId: string) {
  const api = useTravelApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { input: RevokeTripPlaceRequest; idempotencyKey?: string }) =>
      api.revokeTripPlace!(tripId, params.input, { idempotencyKey: params.idempotencyKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tripKeys.places(tripId) });
    },
  });
}
