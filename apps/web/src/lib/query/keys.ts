export const profileKeys = {
  all: ["profile"] as const,
  me: ["profile", "me"] as const,
  memory: ["profile", "me", "memory"] as const,
};

export const tripKeys = {
  all: ["trips"] as const,
  list: ["trips", "list"] as const,
  detail: (tripId: string) => ["trips", tripId, "detail"] as const,
  threads: (tripId: string) => ["trips", tripId, "my-threads"] as const,
  memoryOverrides: (tripId: string) => ["trips", tripId, "memory", "me"] as const,
  memoryGroup: (tripId: string) => ["trips", tripId, "memory", "group"] as const,
  places: (tripId: string) => ["trips", tripId, "places"] as const,
  routeEvidence: (tripId: string, planId: string) =>
    ["trips", tripId, "plans", planId, "route-evidence"] as const,
  mobilityOffers: (tripId: string) =>
    ["trips", tripId, "mobility-offers"] as const,
  researchResults: (tripId: string) =>
    ["trips", tripId, "research-results"] as const,
};

export const invitationKeys = {
  preview: (inviteToken: string) => ["trip-invitations", inviteToken, "preview"] as const,
  invitees: (tripId: string, query: string) => ["trips", tripId, "invitees", query] as const,
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

export const teamOrchestrationKeys = {
  all: ["team-orchestration"] as const,
  proposals: (tripId: string) =>
    ["team-orchestration", tripId, "proposals"] as const,
  constraintsMembers: (tripId: string) =>
    ["team-orchestration", tripId, "constraints", "members"] as const,
  constraintsOwner: (tripId: string) =>
    ["team-orchestration", tripId, "constraints", "owner"] as const,
  plans: (tripId: string) =>
    ["team-orchestration", tripId, "plans"] as const,
  votes: (planId: string) =>
    ["team-orchestration", "votes", planId] as const,
};
