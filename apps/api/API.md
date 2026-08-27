# API Reference

Base URL: `http://localhost:3000/api/v1`

**Authentication**: All endpoints except `/health`, `/metrics`, `/docs`,
`POST /api/v1/bookings/callback`, the anonymous location-reference endpoint,
and `/auth/*` account bootstrap/recovery routes require an access token. The API verifies
the JWT and derives the database identity from its `sub`; clients never submit a
user ID to choose an identity. The callback uses the independent sandbox HMAC
contract documented below and never trusts a user bearer token.

```
Authorization: Bearer <cognito-access-token>
```

**Error Format**:
```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Description of what went wrong",
  "correlationId": "uuid"
}
```

The `x-correlation-id` response header always matches `correlationId` in an
error response body. Request validation failures use `400 Bad Request`.

---

## Custom account recovery

These endpoints support the explicit `NEXT_PUBLIC_AUTH_MODE=custom` prototype.
Normal production identity remains Cognito unless the deployment deliberately
enables and configures this alternate account flow.

- `POST /auth/login`: accepts `username`, `password`, and optional `rememberMe`.
  Email is not a login identifier. A remembered token expires after 30 days.
- `POST /auth/forgot-password`: accepts `email`. In the temporary
  `PASSWORD_RESET_MODE=direct` prototype it returns `mode: "direct"` and a
  one-use `resetToken`, allowing the client to continue without a code. In
  `email-code` mode it returns a generic response and `retryAfterSeconds: 60`;
  non-production also returns `developmentCode`, while production sends the
  six-digit code through configured AWS SES.
- `POST /auth/verify-reset-code`: accepts `email` and a six-digit `code`. The
  code expires after 10 minutes and is blocked after five failed attempts.
  Success returns a one-use `resetToken`.
- `POST /auth/reset-password`: accepts `email`, `resetToken`, `password`, and
  `confirmPassword`; both password values must match and satisfy policy.

Direct mode does not prove mailbox ownership and is an explicitly accepted risk
for the current demo; it must be replaced before real user accounts are allowed.
Recovery inputs and secrets are never logged. Email-code mode in
production requires a verified SES
sender via `PASSWORD_RESET_FROM_EMAIL`, `AWS_REGION`, and runtime-role permission
to call `ses:SendEmail`.

---

## Health

### `GET /health`
No auth required.

**Response**: `{ "status": "ok", "timestamp": "..." }`

---

## Explore location reference

### `POST /explore/location-reference`

Resolve one user-explicit map click using versioned offline data. This endpoint requires
the normal Cognito access token. It never stores the coordinate and the result is a
non-authoritative map reference, not an address, travel candidate, provider offer or
booking/visa conclusion.

**Body:**

```json
{ "latitude": 38.7223, "longitude": -9.1393 }
```

**Response (`REFERENCE`):**

```json
{
  "outcome": "REFERENCE",
  "country": "Portugal",
  "countryCode": "PT",
  "admin1": "Lisbon",
  "admin1Code": "PT-11",
  "nearestCity": "Lisbon",
  "nearestCityCoordinates": { "latitude": 38.7167, "longitude": -9.1333 },
  "distanceKm": 0,
  "source": "Natural Earth + GeoNames",
  "datasetVersion": "2026-08-global.1",
  "checkedAt": "2026-08-25T00:00:00.000Z",
  "isTravelFact": false
}
```

For ocean or unmatched data, the response has `outcome: "NO_REFERENCE"`. A missing
or unreadable local dataset returns `503` and never guesses a result.
`nearestCityCoordinates` is the indexed GeoNames city center used for map pin
normalization; it is `null` whenever `nearestCity` is `null`.

---

## Profiles

### `POST /profiles`
Create or update your profile.

**Body**:
```json
{
  "nationality": "US",
  "interests": ["art", "museums"],
  "accommodationStyle": "city_center",
  "budgetMaxUsd": 5000,
  "noRedEye": true,
  "departureCity": "San Francisco",
  "availableDepartureDates": ["2025-08-01", "2025-08-15"]
}
```

**Response**: `201 { "id": "uuid", "userId": "uuid", "message": "Profile created" }`

### `GET /profiles/me`
Get your profile (sensitive fields redacted).

**Response**:
```json
{
  "profile": {
    "id": "uuid",
    "userId": "uuid",
    "displayName": "Traveler",
    "nationality": "US",
    "dateOfBirth": null,
    "interests": ["art", "museums"],
    "accommodationStyle": "city_center",
    "budgetMaxUsd": 5000,
    "noRedEye": true,
    "mobilityNotes": null,
    "availableDepartureDates": ["2025-08-01", "2025-08-15"],
    "departureCity": "San Francisco",
    "createdAt": "2026-08-24T10:00:00.000Z",
    "updatedAt": "2026-08-24T10:00:00.000Z"
  }
}
```

If no profile exists, the response is `{ "profile": null }`.

`nationality`, `dateOfBirth`, `interests`, `accommodationStyle`,
`budgetMaxUsd`, `noRedEye`, `mobilityNotes`, `availableDepartureDates`, and
`departureCity` are nullable because profiles can be created incrementally.
`createdAt` and `updatedAt` are server-generated ISO 8601 UTC timestamps.
`passportNumber` is never returned.

### `PUT /profiles/me`
Update your profile (partial update).

**Body**: Same writable fields as POST, all optional. This is a strict partial
update:

- A missing field preserves its stored value.
- `null` is rejected and does not clear a value.
- `id`, `userId`, `displayName`, `createdAt`, and `updatedAt` cannot be modified.
- `nationality` can be modified by the profile owner.
- `updatedAt` is generated by the server.

**Response**:
```json
{
  "message": "Profile updated",
  "profile": { "id": "uuid", "displayName": "Traveler", "updatedAt": "..." }
}
```

The `profile` object has the same complete shape and nullability as
`GET /profiles/me`.

### `DELETE /profiles/me`
Delete your profile.

---

## Trips

### `GET /trips`

List only trips where the authenticated user is a member. Membership is
enforced server-side. Results are ordered by `createdAt` descending, then `id`
ascending as a deterministic tie-breaker.

**Response**:
```json
{
  "trips": [
    {
      "id": "trip-uuid",
      "name": "Asia Trip",
      "status": "PLANNING",
      "departureCities": ["San Francisco", "Shanghai"],
      "destinationCandidates": ["Tokyo", "Bangkok", "Seoul"],
      "travelDateStart": "2025-08-01",
      "travelDateEnd": "2025-08-07",
      "memberCount": 3,
      "role": "CREATOR",
      "createdAt": "2026-08-24T10:00:00.000Z"
    }
  ]
}
```

- `status`: `PLANNING | CONFIRMED | BOOKED | CANCELLED | STALE`.
- `role`: the requesting member's `CREATOR | MEMBER` role.
- `travelDateStart` and `travelDateEnd`: nullable `YYYY-MM-DD` strings.
- `departureCities` and `destinationCandidates`: stored trip-record values.
- `memberCount`: derived server-side from current trip memberships.

### `POST /trips`
Create a shared trip.

**Body**:
```json
{
  "name": "Asia Trip 2025",
  "departureCities": ["San Francisco", "Shanghai"],
  "destinationCandidates": ["Tokyo", "Bangkok", "Seoul"],
  "travelDateStart": "2025-08-01",
  "travelDateEnd": "2025-08-07",
  "memberUserIds": ["uuid-bob", "uuid-chen"]
}
```

**Response**: `201 { "id": "uuid", "message": "Trip created" }`

### `POST /trips/:tripId/join`
> **Removed.** Join-by-UUID was replaced by Trip invitations: creators issue `POST /trips/:tripId/invitations` and invitees redeem the token at `POST /trip-invitations/:inviteToken/accept`. See the Trip Invitations section below.

### `GET /trips/:tripId`
Get trip details (members only).

**Response**:
```json
{
  "trip": { "id": "uuid", "name": "...", "status": "PLANNING", ... },
  "members": [
    {
      "userId": "uuid",
      "displayName": "Traveler",
      "role": "CREATOR",
      "isRequired": true,
      "joinedAt": "2026-08-24T10:00:00.000Z"
    }
  ]
}
```

Member objects expose only the safe presentation name alongside membership
state; they do not expose `externalId` or private Profile fields.

---

## Consent

### `POST /consent/grant`
Grant consent for a specific scope and field list.

**Body**:
```json
{
  "tripId": "uuid",
  "scope": "PROFILE_PREFERENCES",
  "fieldList": ["interests", "accommodationStyle"]
}
```

**Available Scopes**:
- `PROFILE_BASIC` — name, avatar
- `PROFILE_PREFERENCES` — interests, accommodation style
- `PROFILE_NATIONALITY` — nationality/citizenship
- `PROFILE_DOCUMENTS` — passport info (redacted display)
- `PROFILE_BUDGET` — budget constraints
- `PROFILE_RESTRICTIONS` — red-eye refusal, mobility, etc.

**Response**: `{ "message": "Consent granted", "scope": "...", "fieldList": [...] }`

### `POST /consent/revoke`
Revoke consent for a specific scope.

**Body**:
```json
{
  "tripId": "uuid",
  "scope": "PROFILE_NATIONALITY"
}
```

**Response**: `{ "message": "Consent revoked", "scope": "..." }`

> **Important**: Revoking consent causes all related plans to become `STALE`.

### `GET /consent/:tripId/me`
Get your active consents for a trip.

**Response**:
```json
{
  "consents": [
    { "scope": "PROFILE_PREFERENCES", "fieldList": ["interests", "accommodationStyle"] }
  ]
}
```

---

## Planning

### `POST /planning/generate`
Generate a new plan for a trip.

**Body**:
```json
{
  "tripId": "uuid"
}
```

**Response**:
```json
{
  "snapshotId": "uuid",
  "plans": [
    {
      "planId": "uuid",
      "destination": "Tokyo",
      "snapshotId": "uuid"
    }
  ],
  "visaChecksByDestination": {
    "Tokyo": [
      {
        "memberId": "uuid",
        "destinationCountry": "Japan",
        "status": "AUTHORIZED_CHECK",
        "checklist": [...],
        "confidenceLevel": "HIGH",
        "disclaimer": "..."
      }
    ]
  },
  "latestPlan": {
    "destination": "Tokyo",
    "flights": [...],
    "stays": [...],
    "ground": [...],
    "generatedAt": "..."
  },
  "message": "Plans generated for 1 destination candidate(s)"
}
```

> All flight/stay/ground data includes `source: "Demo data"` and `isDemo: true`.
> Fixture offers also include a stable `capturedAt` and `fixtureVersion`. The
> Each persisted destination plan includes one selected flight per configured
> departure origin. `plans` identifies every persisted candidate; `latestPlan`
> contains the validated data for the latest active plan.

**Unsupported fixture response**: `422`

```json
{
  "statusCode": 422,
  "error": "PlanningDataUnavailableError",
  "message": "Planning data unavailable: flight:Singapore",
  "correlationId": "uuid"
}
```

No plan is created when a required origin, stay, or ground fixture is missing.

**Invalid model plan response**: `422`

```json
{
  "statusCode": 422,
  "error": "PlanValidationError",
  "message": "Plan output failed deterministic validation",
  "correlationId": "uuid",
  "violations": [
    {
      "code": "EVIDENCE_MISMATCH",
      "fieldPath": "flights.0",
      "reason": "Offer does not exactly match provider evidence"
    }
  ]
}
```

The planning control plane rejects malformed output, unauthorized snapshot
field references, unapproved origins/destinations, missing provenance, and
offers that do not exactly match provider evidence. Optional field references
use `authorizedData.<memberId>.<fieldName>`. Violation responses contain no
rejected values or private Profile data. Validation runs before authoritative
plan persistence, so a rejected candidate creates no plan.

### `GET /planning/:tripId/latest`
Get the latest active plan for a trip.

---

## Confirmations

### `POST /confirmations`
Confirm or request changes for a plan.

**Body**:
```json
{
  "planId": "uuid",
  "tripId": "uuid",
  "decision": "CONFIRMED" | "NEEDS_CHANGES"
}
```

**Response**:
```json
{
  "message": "Confirmation set to CONFIRMED",
  "allConfirmed": false,
  "confirmations": [
    { "userId": "uuid", "status": "CONFIRMED" },
    { "userId": "uuid", "status": "PENDING" },
    { "userId": "uuid", "status": "CONFIRMED" }
  ]
}
```

### `GET /confirmations/:planId`
Get confirmation status for a plan.

---

## Trip-scoped chat threads

Every chat thread belongs to exactly one shared trip (see migration `0012_trip_scoped_threads.sql`). These are the only endpoints new clients should call.

### `GET /trips/:tripId/threads`
List the caller's own threads within the trip (server-filtered by `ownerUserId`).

**Response**: `{ "threads": [ThreadSummary, …] }`

### `POST /trips/:tripId/threads`
Create a non-default thread in the trip. Caller must be a trip member.

**Body**: `{ "title": "Hotel ideas" }`

**Response**: `201 ThreadSummary`

### `POST /trips/:tripId/threads/default`
Idempotent provision of the caller's per-trip default scratchpad (used by `TravelAgentChat` on Explore). Creates the row on first call, returns the existing one thereafter. Caller must be a trip member.

**Response**: `200 ThreadSummary`

---

## Private Chat Threads

All thread and conversation routes require Cognito bearer authentication and
enforce `thread.owner_user_id === request.user.id`. Binding a thread to a trip
does not grant fellow trip members access.

### `POST /threads`

> **Deprecated.** Use `POST /trips/:tripId/threads` (create) or
> `POST /trips/:tripId/threads/default` (idempotent default). This shim
> remains so existing fixtures/tests keep working; new clients must not call it.

Create an owner-only private thread. Body: `{ "title": "Tokyo ideas", "tripId"?: "uuid" }`. `tripId` is required and the caller must be a member of that trip.

### `GET /threads`

> **Deprecated.** Use `GET /trips/:tripId/threads`.

List only the authenticated owner's threads.

### `POST /threads/:threadId/turns`

Accept one idempotent Personal Agent conversation task. Clients supply no role
or sender identity. The acceptance transaction persists the question as
`USER`, creates one durable run, and returns `202` without waiting for Gemini.
An independent Worker later persists the final, validated `ASSISTANT` message.

**Body**:

```json
{
  "requestId": "uuid",
  "question": "Tell me about Tokyo",
  "place": {
    "sourceId": "tokyo",
    "name": "Tokyo",
    "latitude": 35.6895,
    "longitude": 139.6917,
    "sourceType": "REFERENCE"
  }
}
```

`place` is optional. `INSPIRATION` means unverified user-provided context and
is never authoritative evidence for prices, inventory, visa requirements, or
booking availability.

**`202 Accepted` response**:

```json
{
  "threadId": "uuid",
  "runId": "uuid",
  "operation": "CONVERSATION",
  "status": "QUEUED",
  "generationAttempt": 0,
  "userMessage": {
    "id": "uuid",
    "role": "USER",
    "content": "Tell me about Tokyo",
    "sequence": 1,
    "createdAt": "2026-08-25T00:00:00.000Z"
  }
}
```

Repeating the same `requestId` returns the same accepted run and USER message.
Only one active run is allowed per thread. Provider failure is handled by the
Worker's bounded retries; terminal failure preserves the USER message, stores no
partial ASSISTANT body, and exposes only an allow-listed error code through the
run read API.

### `GET /agent-runs/:runId`

Returns the authenticated creator's durable operation/status, attempt counters,
timestamps, safe terminal error code, and final resource IDs. It never returns
the prompt, question, partial text, model payload, credentials, or private
snapshot data. Cross-user reads return `403`.

### `POST /agent-runs/:runId/cancel`

The only task cancellation mechanism. A queued run becomes `CANCELLED`
immediately; a running run becomes `CANCEL_REQUESTED` until its Worker observes
the request and aborts the upstream call. Closing an SSE connection, refreshing,
or leaving the page does not call this endpoint and does not cancel work.

### `GET /agent-runs/:runId/events`

Authenticated `text/event-stream` observation endpoint intended for browser
`fetch` with the normal Bearer header. Events are strict allow-listed envelopes:
`turn.started`, `run.phase`, safety-approved `message.delta`, and exactly one of
`turn.completed`, `turn.cancelled`, `turn.stale`, or `turn.failed` for a connected
observer. Events may be missed during disconnects; clients must recover from
`GET /agent-runs/:runId` and the final conversation history. SSE is not a queue
and does not own task execution.

Each event carries an optional `traceparent` field (W3C trace-context header
value, `00-<32-hex>-<16-hex>-<flags>`). When present, it lets an OTel-aware
observer link an `sse.event.*` span back to the originating HTTP server span.
PII / credentials are never embedded here — only OTel identifiers.

The handler hijacks the reply to own the socket, so it writes the headers the
request already negotiated — the configured cross-origin decision and
`x-correlation-id` — onto the stream itself. A browser that cannot read the
cross-origin headers rejects the stream and silently degrades to polling
`GET /agent-runs/:runId`, which still returns the correct final answer but loses
incremental delivery.

### `GET /threads/:threadId/conversation`

Returns up to the latest 100 raw `USER`/`ASSISTANT` messages in chronological
order for the owner UI. This endpoint is deliberately separate from
`thread.recall`, which exposes only safe/redacted Agent context.

### `POST /threads/:threadId/messages`

Legacy owner-only, one-way append. The strict body accepts `body` and optional
`markedSharedByOwner`; the server always writes role `USER`. Client-supplied
`SYSTEM`, `ASSISTANT`, or sender identity fields are rejected.

### `DELETE /threads/:threadId`

Deletes the owner thread and cascades its message bodies.

---

## Bookings

### `POST /bookings`
Submit a booking to the sandbox.

**Requirements**: All 3 required members must have `CONFIRMED` the latest active plan.

**Body**:
```json
{
  "planId": "uuid",
  "tripId": "uuid",
  "orchestrationRequestId": "uuid"
}
```

**Response**:
```json
{
  "message": "Booking submitted",
  "orchestrationRequestId": "uuid",
  "results": [
    { "service": "flight", "status": "SUCCESS", "reference": "DEMO-FLT-001" },
    { "service": "hotel", "status": "SUCCESS", "reference": "DEMO-HTL-001" },
    { "service": "ground", "status": "SUCCESS", "reference": "DEMO-GND-001" }
  ],
  "isDuplicate": false
}
```

> **Sandbox**: No real payments. References are demo values prefixed with `DEMO-`.

### `POST /bookings/callback`
Handle async sandbox callback.

**Authentication headers**:

```text
X-Sandbox-Timestamp: <Unix epoch milliseconds>
X-Sandbox-Signature: <lowercase-or-uppercase hex HMAC-SHA256>
```

The canonical signed bytes are `${timestamp}.${rawRequestBody}`. The server
computes HMAC-SHA256 with `SANDBOX_HMAC_SECRET`, compares signatures using a
timing-safe operation, and accepts timestamps at or within five minutes of the
server clock. The exact received JSON bytes are signed; reformatting JSON after
signing invalidates the signature. Missing, malformed, invalid, expired, or
unconfigured authentication fails closed with the same generic `401` response:

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "Callback authentication failed",
  "correlationId": "uuid"
}
```

Detailed cryptographic failure causes, signatures, and secrets are never
returned. Providers must use a unique `eventId`; duplicate and late callbacks
retain the existing idempotent behavior.

**Body**:
```json
{
  "orchestrationRequestId": "uuid",
  "eventId": "uuid",
  "serviceResults": {
    "flight": { "status": "SUCCESS", "reference": "DEMO-FLT-001" },
    "hotel": { "status": "FAILED", "error": "No availability" }
  }
}
```

**Response**: `200` with `isDuplicate: false` for the first accepted event, or
`isDuplicate: true` when the event was already processed or the booking is in a
terminal state.

---

## Change Events

### `POST /change-events`
Submit a change event (triggers replan).

**Body**:
```json
{
  "tripId": "uuid",
  "eventId": "uuid",
  "eventType": "PRICE_CHANGE" | "INVENTORY_CHANGE" | "DEPARTURE_RESTRICTION",
  "payload": {
    "flightId": "flt-sfo-tyo-01",
    "oldPrice": 850,
    "newPrice": 1200
  }
}
```

**Response**:
```json
{
  "message": "Change event processed, plan regenerated",
  "replanned": true,
  "newPlanId": "uuid",
  "oldPlanId": "uuid"
}
```

> **Idempotency**: Duplicate `eventId` returns cached result without reprocessing.

---

## Demo Change Events

Use these `eventId` values for testing:

| Event | Type | Payload |
|-------|------|---------|
| Price increase | `PRICE_CHANGE` | `{ "flightId": "flt-sfo-tyo-01", "oldPrice": 850, "newPrice": 1200 }` |
| Sold out | `INVENTORY_CHANGE` | `{ "flightId": "flt-sfo-tyo-01", "status": "SOLD_OUT" }` |
| Departure restriction | `DEPARTURE_RESTRICTION` | `{ "userId": "chen", "reason": "Schedule conflict" }` |
