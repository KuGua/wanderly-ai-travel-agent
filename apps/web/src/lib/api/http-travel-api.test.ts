import { describe, expect, it, vi } from "vitest";

import { HttpTravelApi } from "./http-travel-api";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const ASSISTANT_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = "2026-08-25T10:00:00.000Z";

describe("HttpTravelApi private conversation", () => {
  it("uses the thread endpoints and sends only the strict turn contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: THREAD_ID, message: "Thread created" }, 201))
      .mockResolvedValueOnce(jsonResponse({ threads: [thread()] }))
      .mockResolvedValueOnce(jsonResponse({ thread: thread(), messages: [] }))
      .mockResolvedValueOnce(jsonResponse({
        threadId: THREAD_ID,
        userMessage: { id: USER_ID, role: "USER", content: "Tell me about Tokyo", createdAt: CREATED_AT },
        assistantMessage: { id: ASSISTANT_ID, role: "ASSISTANT", content: "General guidance", createdAt: CREATED_AT },
        responseMode: "MODEL",
      }));
    const api = new HttpTravelApi("https://api.example.test", fetchMock);

    await api.createThread({ title: "Explore · Tokyo" });
    await api.getThreads();
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
      "https://api.example.test/api/v1/threads",
      "https://api.example.test/api/v1/threads",
      `https://api.example.test/api/v1/threads/${THREAD_ID}/conversation`,
      `https://api.example.test/api/v1/threads/${THREAD_ID}/turns`,
    ]);
    const turnOptions = fetchMock.mock.calls[3][1] as RequestInit;
    expect(turnOptions.method).toBe("POST");
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
});

function thread() {
  return {
    id: THREAD_ID,
    ownerUserId: OWNER_ID,
    tripId: null,
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
