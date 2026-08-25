export const profileKeys = {
  all: ["profile"] as const,
  me: ["profile", "me"] as const,
};

export const tripKeys = {
  all: ["trips"] as const,
  list: ["trips", "list"] as const,
};

export const threadKeys = {
  all: ["threads"] as const,
  list: ["threads", "list"] as const,
  conversation: (threadId: string) => ["threads", threadId, "conversation"] as const,
};
