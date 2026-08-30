export const profileKeys = {
  all: ["profile"] as const,
  me: ["profile", "me"] as const,
};

export const tripKeys = {
  all: ["trips"] as const,
  list: ["trips", "list"] as const,
  detail: (tripId: string) => ["trips", tripId, "detail"] as const,
  threads: (tripId: string) => ["trips", tripId, "my-threads"] as const,
  planningRun: (tripId: string) => ["trips", tripId, "planning-run"] as const,
  latestPlan: (tripId: string) => ["trips", tripId, "latest-plan"] as const,
};

export const threadKeys = {
  all: ["threads"] as const,
  list: ["threads", "list"] as const,
  conversation: (threadId: string) => ["threads", threadId, "conversation"] as const,
};

export const locationIntroductionKeys = {
  all: ["location-introductions"] as const,
  detail: (input: { sourceId: string; locale: "en" | "zh" }) =>
    ["location-introductions", input.sourceId, input.locale] as const,
};
