# API Reference

Base URL: `http://localhost:3000/api/v1`

**Authentication**: All endpoints (except `/health`) require the `X-Demo-User` header.

```
X-Demo-User: alice | bob | chen
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

---

## Health

### `GET /health`
No auth required.

**Response**: `{ "status": "ok", "timestamp": "..." }`

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
    "interests": ["art", "museums"],
    "accommodationStyle": "city_center",
    "noRedEye": true,
    "departureCity": "San Francisco"
  }
}
```

> **Note**: `passportNumber` is never returned. `nationality` is only returned if it exists in the profile.

### `PUT /profiles/me`
Update your profile (partial update).

**Body**: Same as POST, all fields optional.

### `DELETE /profiles/me`
Delete your profile.

---

## Trips

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
Join an existing trip.

**Response**: `{ "message": "Joined trip" }`

### `GET /trips/:tripId`
Get trip details (members only).

**Response**:
```json
{
  "trip": { "id": "uuid", "name": "...", "status": "PLANNING", ... },
  "members": [{ "userId": "uuid", "role": "CREATOR", "isRequired": true }]
}
```

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
  "planId": "uuid",
  "snapshotId": "uuid",
  "plan": {
    "destination": "Tokyo",
    "flights": [...],
    "stays": [...],
    "ground": [...],
    "generatedAt": "..."
  },
  "visaChecks": [
    {
      "memberId": "uuid",
      "destinationCountry": "Japan",
      "status": "AUTHORIZED_CHECK",
      "checklist": [...],
      "confidenceLevel": "HIGH",
      "disclaimer": "..."
    }
  ]
}
```

> All flight/stay/ground data includes `source: "Demo data"` and `isDemo: true`.

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
