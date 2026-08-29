"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ConversationTurnRequest,
  ConversationTurnAcceptedResponse,
  CreateTripThreadInput,
  OwnerConversationResponse,
  ThreadsResponse,
  TripActivationRequest,
  UpdateProfileInput,
  CastAdoptionVoteRequest,
  ConfirmTripConstraintProposalRequest,
  CreateTripConstraintProposalRequest,
  UpsertTripConstraintFactRequest,
} from "@/lib/api/contracts";
import { useTravelApi } from "./provider";
import { profileKeys, threadKeys, tripKeys, teamOrchestrationKeys } from "./keys";

export function useMyProfile() {
  const api = useTravelApi();
  return useQuery({
    queryKey: profileKeys.me,
    queryFn: () => api.getMyProfile(),
  });
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
