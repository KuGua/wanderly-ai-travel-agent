# Frontend Cognito Authentication

The web app uses the existing Amazon Cognito User Pool contract. The account
control signs in with the email address or phone number configured as the
Cognito username. AWS Amplify Auth owns browser session and refresh-token
storage; Wanderly does not copy access tokens into its own local storage.

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

## Validation

```bash
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web test
```

After supplying ignored local configuration, run the API on port 3000 and Web
on port 3001, sign in through the account control, and verify a protected API
request returns an authenticated response instead of 401/503.

For pre-Cognito local integration only, the server also exposes the explicit,
loopback-only mode documented in [`local-development-auth.md`](./local-development-auth.md).
It does not create a browser session or token and cannot activate in production.
