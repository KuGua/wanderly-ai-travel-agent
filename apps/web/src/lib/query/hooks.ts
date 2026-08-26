"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ConversationTurnRequest,
  ConversationTurnAcceptedResponse,
  CreateThreadInput,
  OwnerConversationResponse,
  UpdateProfileInput,
} from "@/lib/api/contracts";
import { useTravelApi } from "./provider";
import { profileKeys, threadKeys, tripKeys } from "./keys";

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

export function useThreads() {
  const api = useTravelApi();
  return useQuery({ queryKey: threadKeys.list, queryFn: () => api.getThreads() });
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

export function useCreateThread() {
  const api = useTravelApi();
  return useMutation({ mutationFn: (input: CreateThreadInput) => api.createThread(input) });
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

function mergeConversationMessages(
  current: OwnerConversationResponse["messages"],
  incoming: OwnerConversationResponse["messages"],
) {
  const messages = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => messages.set(message.id, message));
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence);
}
