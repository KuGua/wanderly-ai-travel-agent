import { describe, expect, it, vi } from "vitest";

import { HttpTravelApi } from "./http-travel-api";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = "2026-08-25T10:00:00.000Z";

describe("HttpTravelApi private conversation", () => {
  it("uses the trip-scoped thread endpoints and sends only the strict turn contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(thread(), 200))
      .mockResolvedValueOnce(jsonResponse({ thread: thread(), messages: [] }))
      .mockResolvedValueOnce(jsonResponse({
        threadId: THREAD_ID,
        runId: RUN_ID,
        operation: "CONVERSATION",
        status: "QUEUED",
        generationAttempt: 0,
        userMessage: { id: USER_ID, role: "USER", content: "Tell me about Tokyo", sequence: 1, createdAt: CREATED_AT },
      }, 202));
    const api = new HttpTravelApi("https://api.example.test", fetchMock);

    const tripId = "99999999-9999-4999-8999-999999999999";
    await api.getOrCreateDefaultTripThread(tripId);
    await api.getOwnerConversation(THREAD_ID);
    await api.submitConversationTurn(THREAD_ID, {
      requestId: REQUEST_ID,
      question: "Tell me about Tokyo",
      place: {
        sourceId: "tokyo",
        name: "Tokyo",
        longitude: 139.6917,
        latitude: 35.6895,
        sourceType: "REFERENCE",
      },
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.example.test/api/v1/trips/${tripId}/threads/default`,
      `https://api.example.test/api/v1/threads/${THREAD_ID}/conversation`,
      `https://api.example.test/api/v1/threads/${THREAD_ID}/turns`,
    ]);
    const turnOptions = fetchMock.mock.calls[2][1] as RequestInit;
    expect(turnOptions.method).toBe("POST");
    expect(new Headers(turnOptions.headers).has("Authorization")).toBe(false);
    const body = JSON.parse(String(turnOptions.body));
    expect(body).toEqual({
      requestId: REQUEST_ID,
      question: "Tell me about Tokyo",
      place: {
        sourceId: "tokyo",
        name: "Tokyo",
        longitude: 139.6917,
        latitude: 35.6895,
        sourceType: "REFERENCE",
      },
    });
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("senderUserId");
  });

  it("reads, cancels, and subscribes to an authenticated durable run", async () => {
    const run = {
      runId: RUN_ID,
      operation: "CONVERSATION",
      status: "RUNNING",
      generationAttempt: 1,
      attemptCount: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      finishedAt: null,
      errorCode: null,
      assistantMessageId: null,
      resultPlanId: null,
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `event: message.delta\r\ndata: {"runId":"${RUN_ID}","generationAttempt":1,\r\ndata: "sequence":0,"delta":"Hello"}\r\n\r\n`,
        ));
        controller.close();
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(run))
      .mockResolvedValueOnce(jsonResponse({ ...run, status: "CANCEL_REQUESTED" }))
      .mockResolvedValueOnce(new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));
    const api = new HttpTravelApi("https://api.example.test", fetchMock, async () => "test-access-token");
    const events: unknown[] = [];

    await api.getAgentRun(RUN_ID);
    await api.cancelAgentRun(RUN_ID);
    await api.subscribeAgentRun(RUN_ID, new AbortController().signal, (event) => events.push(event));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.example.test/api/v1/agent-runs/${RUN_ID}`,
      `https://api.example.test/api/v1/agent-runs/${RUN_ID}/cancel`,
      `https://api.example.test/api/v1/agent-runs/${RUN_ID}/events`,
    ]);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("POST");
    expect(new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers).get("Authorization"))
      .toBe("Bearer test-access-token");
    expect(events).toEqual([{
      event: "message.delta",
      runId: RUN_ID,
      generationAttempt: 1,
      sequence: 0,
      delta: "Hello",
    }]);
  });
});

describe("HttpTravelApi invitation join", () => {
  it("uses an opaque token for preview, accept, and decline instead of a trip ID", async () => {
    const token = "a".repeat(43);
    const preview = {
      trip: { name: "Kyoto together", destinationCandidates: ["Kyoto"], travelDateStart: null, travelDateEnd: null },
      membership: "MEMBER" as const,
      isRequired: true as const,
      expiresAt: CREATED_AT,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(preview))
      .mockResolvedValueOnce(jsonResponse({ tripId: "99999999-9999-4999-8999-999999999999", membership: "MEMBER", defaultThread: { id: THREAD_ID, tripId: "99999999-9999-4999-8999-999999999999", isDefault: true } }))
      .mockResolvedValueOnce(jsonResponse({ declined: true }));
    const api = new HttpTravelApi("https://api.example.test", fetchMock);

    await api.getInvitationPreview(token);
    await api.acceptInvitation(token);
    await api.declineInvitation(token);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.example.test/api/v1/trip-invitations/${token}`,
      `https://api.example.test/api/v1/trip-invitations/${token}/accept`,
      `https://api.example.test/api/v1/trip-invitations/${token}/decline`,
    ]);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("POST");
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("POST");
  });

  it("creates an email-bound invitation", async () => {
    const tripId = "99999999-9999-4999-8999-999999999999";
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ invitationId: THREAD_ID, inviteToken: "a".repeat(43), expiresAt: CREATED_AT }, 201));
    const api = new HttpTravelApi("https://api.example.test", fetchMock);

    await api.createTripInvitation(tripId, { recipientEmail: "bob@example.test", expiresAt: CREATED_AT });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.example.test/api/v1/trips/${tripId}/invitations`,
    ]);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ recipientEmail: "bob@example.test", expiresAt: CREATED_AT });
  });
});

function thread() {
  return {
    id: THREAD_ID,
    ownerUserId: OWNER_ID,
    tripId: "99999999-9999-4999-8999-999999999999",
    scope: "TRIP" as const,
    isDefault: false,
    title: "Explore · Tokyo",
    createdAt: CREATED_AT,
    archivedAt: null,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
