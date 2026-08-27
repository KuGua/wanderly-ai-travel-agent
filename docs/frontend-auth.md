# Frontend Cognito Authentication

The normal web deployment uses the existing Amazon Cognito User Pool contract.
The account form accepts a username only. AWS Amplify Auth owns browser session
and refresh-token storage; Wanderly does not copy Cognito access tokens into its
own storage. The Cognito app client must use a 30-day refresh-token lifetime for
the checked “Remember me for 30 days” option. Checked sessions use Amplify's
persistent storage; unchecked sessions use session storage.

For every protected API request, `ApiClient` calls `fetchAuthSession()` through
the auth provider and sends the current Cognito **access token** as
`Authorization: Bearer <token>`. The API verifies `tokenUse: access` against
`COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID`, provisions the token subject as
the server-side user identity, and never accepts a browser-supplied user ID.
Signing in or out clears the TanStack Query cache so private results from one
session cannot remain visible in another.

## Configuration

The Cognito app client must be a browser/public client without a client secret.
Use the same pool and app client on both sides:

```dotenv
# apps/web/.env.local — public identifiers, safe to expose to the browser
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-east-1_example
NEXT_PUBLIC_COGNITO_CLIENT_ID=example-public-app-client-id

# apps/api/.env — server runtime configuration
COGNITO_USER_POOL_ID=us-east-1_example
COGNITO_CLIENT_ID=example-public-app-client-id
```

Do not place passwords, tokens, app-client secrets, or model-provider keys in
the web environment. A real local sign-in additionally requires a confirmed
user in that User Pool. The MVP form supports a completed username/password
sign-in; accounts requiring a new password, MFA, or another Cognito challenge
receive an explicit unsupported-challenge message rather than an auth bypass.

## Custom-local password authentication

`NEXT_PUBLIC_AUTH_MODE=custom-local` selects the API-owned username/password flow.
Login accepts only `username`; email remains the recovery attribute. The
forgot-password screen currently requests an email and continues directly to a
new password form, checks both password fields, and returns to login immediately
or automatically after five seconds. This `PASSWORD_RESET_MODE=direct` path is
used by the current local and deployed demos, but it does not prove mailbox ownership.
Checked
login sessions receive a token capped at 30 days and use persistent browser
storage; unchecked sessions are stored only for the browser session.

Set `PASSWORD_RESET_MODE=email-code` when mail delivery becomes available to
restore the retained six-digit code UI/API flow and 60-second resend delay. The
database change is versioned in `0011_custom_auth_credentials.sql`; existing
Cognito/local-dev users keep nullable credential columns. Reset codes expire in
10 minutes, permit at most five attempts, and reset tokens are one-use. Codes,
emails and reset tokens must never enter logs. Production delivery uses AWS SES
with `AWS_REGION` and `PASSWORD_RESET_FROM_EMAIL`; the sender/domain must be SES
verified and the workload role needs `ses:SendEmail`. Email-code mode outside
production returns a
development-only code so the local UI can exercise the flow without pretending
that an email was sent. Reset challenges are currently process-local, so an API
restart invalidates them and a multi-instance deployment must move challenge
state to a shared TTL store before enabling custom auth at scale.

`custom-local` is refused outside local development and requires a loopback API
URL, an exact loopback Origin allow-list, and an API-only `JWT_SECRET` of at
least 32 characters. It supports local multi-user isolation tests only; normal
and production authentication remains Cognito.

## Validation

```bash
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web test
```

After supplying ignored local configuration, run the API on port 3000 and Web
on port 3001, sign in through the account control, and verify a protected API
request returns an authenticated response instead of 401/503.

[`local-development-auth.md`](./local-development-auth.md) distinguishes
`custom-local` from `local-dev`: the latter remains a token-free, fixed-user
smoke-test path and cannot validate multi-user behavior.
