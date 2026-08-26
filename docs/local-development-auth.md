# Strict Local Development Authentication

`AUTH_MODE=local-dev` exists only to run the real browser → API → database →
Agent path before an AWS Cognito User Pool is available. Cognito remains the
default and the production authentication mechanism.

Local development mode is fail-closed:

- it is rejected when `NODE_ENV=production`;
- API startup is rejected unless `HOST` is loopback-only;
- each protected request is rejected unless its actual socket peer is loopback
  (`trustProxy` is not enabled, so forwarded client headers do not choose it);
- the server provisions one fixed `local-dev:default-traveler` external subject
  and resolves its database UUID itself;
- bearer tokens, user IDs, demo-user headers and message roles from the browser
  cannot select another identity;
- normal route ownership, authorization, idempotency and persistence checks are
  unchanged.

## Fresh-checkout setup

Run all commands below from the repository root. Install dependencies if they
are not already present, then create ignored local environment files from the
checked-in examples:

```bash
npm --prefix apps/api install
npm --prefix apps/web install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

The examples already contain the loopback, database, local-auth and browser API
settings. Each teammate must provide only their own real
`MODEL_GATEWAY_API_KEY` in `apps/api/.env`. The configured Gemini path uses the
built-in OpenAI-compatible endpoint and defaults to `gemini-3.1-flash-lite`:

```dotenv
# apps/api/.env
AUTH_MODE=local-dev
NODE_ENV=development
HOST=127.0.0.1
MODEL_GATEWAY_PROVIDER=gemini
MODEL_GATEWAY_API_KEY=<teammate's local Google AI Studio key>

# apps/web/.env.local
NEXT_PUBLIC_AUTH_MODE=local-dev
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
```

The key belongs only in ignored `apps/api/.env`. Never put it in
`apps/web/.env.local`, any `NEXT_PUBLIC_*` variable, source code, tests, logs or
Git. Each teammate may use their own Google AI Studio key. If the team shares a
key, transfer it privately through the team's approved secret-sharing channel,
never through Git, chat screenshots or committed documentation.

`AUTH_MODE=local-dev` does not disable authorization and does not let the
browser fabricate a token or user ID. The backend supplies one fixed,
development-only, server-owned identity while all normal ownership and
authorization checks remain active. Production continues to use Cognito.

## Start the working local stack

Ensure PostgreSQL is running and matches the existing `DB_*` values in
`apps/api/.env`. API and Web must run in separate terminals.

Run migrations, then start the API in the first terminal:

```bash
npm --prefix apps/api run db:migrate
npm --prefix apps/api run dev
```

Start Web in the second terminal:

```bash
npm --prefix apps/web run dev -- --port 3001
```

Expected endpoints:

- API health: `http://127.0.0.1:3000/health`
- Web application: `http://localhost:3001/en/home`

After changing `apps/api/.env`, restart API. After changing
`apps/web/.env.local`, restart Web; Next.js public environment variables are
loaded when the Web process starts.

## Port troubleshooting

If startup reports `EADDRINUSE`, identify the exact listener before stopping
anything:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:3001 -sTCP:LISTEN
```

An old Node development process may still own the port. Verify its PID and
command, stop that specific old process, and then start only one API and one Web
server. Do not run duplicate API watchers because one may retain stale model or
environment configuration.

## Browser-to-Agent smoke test

1. Open `http://localhost:3001/en/home` and select a destination.
2. Ask `Tell me more about Tokyo`.
3. Expect a real assistant bubble backed by Gemini with response mode `MODEL`.
4. Ask `I'm a Chinese citizen, do I need a visa to go to Tokyo?`.
5. Expect deterministic `SAFE_REFUSAL` behavior with `Verification required`.

In local-dev mode the account control shows an explicit local development
indicator and `ApiClient` sends no Authorization header. Provider failure still
fails closed; the application never substitutes a production mock response.

Return both applications to Cognito mode by removing the ignored local-dev
overrides or setting `AUTH_MODE=cognito` and `NEXT_PUBLIC_AUTH_MODE=cognito`.
