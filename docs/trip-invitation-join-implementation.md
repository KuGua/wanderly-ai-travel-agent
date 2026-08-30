# Token-bound trip invitation acceptance

The external entry point is `/trips/join/:inviteToken` (under the locale
prefix). The dynamic value is a 32-byte, base64url invitation token, not a
Trip ID. It is only a transport handle: the API persists its SHA-256 hash and
never returns the token after creation.

## API boundary

All invitation endpoints require authentication. `GET /trip-invitations/:token`
returns only the decision summary (trip name, candidate destinations, date
range, recipient role and expiry) after both the token and invited account
match. Invalid, expired, declined, revoked, accepted and wrong-account tokens
all return the same `404 Invitation is unavailable`; no trip, member, or
inviter metadata is disclosed.

The raw token is also redacted from request logs and normalized to the route
shape in the inbound trace target; it is never placed in audit summaries,
metric labels, or span attributes.

`POST .../accept` provisions the required membership and personal default
thread idempotently. `POST .../decline` records `DECLINED` with a safe audit
event; it does not create membership or a thread. Creator revocation remains
separate (`REVOKED`). Both actions are server-authoritative and token-bound.

## UX and privacy

Before authentication the page does not fetch or render trip facts. After
acceptance, its sole primary action is **Set your sharing scope**. Acceptance
does not grant consent or copy profile, nationality, document, or private-chat
data into a trip snapshot. The receiving workspace must collect explicit
field-level consent before a snapshot is created.

## Verification

- `apps/web`: `npm run typecheck` and `npm test -- http-travel-api.test.ts`
- `apps/api`: `npm run typecheck`
- Apply migration `0025_trip_invitation_decline.sql` before serving decline
  requests. It adds the enum values and `declined_at` safely with `IF NOT
  EXISTS`.
