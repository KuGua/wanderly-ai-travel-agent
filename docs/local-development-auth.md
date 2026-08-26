# Strict Local Development Authentication

`AUTH_MODE=local-dev` exists only to run the real browser → API → database →
Agent path before an AWS Cognito User Pool is available. Cognito remains the
default and the production authentication mechanism.

Local development mode is fail-closed:

- it is rejected unless `NODE_ENV` is `development` or `test`;
- API startup is rejected unless `HOST` is loopback-only;
- each protected request is rejected unless its actual socket peer is loopback
  (`trustProxy` is not enabled, so forwarded client headers do not choose it);
- only explicit loopback browser Origins may read API responses; protected
  `POST`/`PUT`/`PATCH`/`DELETE` requests also require one of those Origins;
- the server provisions one fixed `local-dev:default-traveler` external subject
  and resolves its database UUID itself;
- bearer tokens, user IDs, demo-user headers and message roles from the browser
  cannot select another identity;
- normal route ownership, authorization, idempotency and persistence checks are
  unchanged.

## Fresh-checkout setup

Run all commands below from the repository root. Install dependencies if they
are not already present, then create ignored local environment files from the
checked-in examples **only when they do not already exist**. Do not overwrite a
teammate's ignored `.env` file.

```bash
npm --prefix apps/api install
npm --prefix apps/web install
test -e apps/api/.env || cp apps/api/.env.example apps/api/.env
test -e apps/web/.env.local || cp apps/web/.env.example apps/web/.env.local
```

PowerShell equivalent:

```powershell
if (!(Test-Path apps/api/.env)) { Copy-Item apps/api/.env.example apps/api/.env }
if (!(Test-Path apps/web/.env.local)) { Copy-Item apps/web/.env.example apps/web/.env.local }
```

The examples already contain the loopback, database, local-auth and browser API
settings. Each teammate must provide only their own real
`MODEL_GATEWAY_API_KEY` and `MODEL_GATEWAY_MODEL` in `apps/api/.env`. This local
configuration explicitly selects `gemini-3.1-flash-lite` through Gemini's
built-in OpenAI-compatible endpoint; the runtime defaults neither provider nor
model:

```dotenv
# apps/api/.env
AUTH_MODE=local-dev
NODE_ENV=development
HOST=127.0.0.1
LOCAL_DEV_ALLOWED_ORIGINS=http://localhost:3001,http://127.0.0.1:3001
MODEL_GATEWAY_PROVIDER=gemini
MODEL_GATEWAY_API_KEY=<teammate's local Google AI Studio key>
MODEL_GATEWAY_MODEL=gemini-3.1-flash-lite

# apps/web/.env.local
NEXT_PUBLIC_AUTH_MODE=local-dev
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
```

`LOCAL_DEV_ALLOWED_ORIGINS` is a comma-separated allow-list of exact browser
Origins. Every value must be an `http://` loopback Origin (for example
`http://localhost:3001`), with no path, query, credentials or public/LAN host.
The Web application's browser Origin must match one entry; its API base URL must
separately remain loopback (normally `http://localhost:3000`). Do not add a
phone, LAN, tunnel or deployed URL to this mode.

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

Start PostgreSQL before migrations. The repository compose file can run only
the database service; do not start its `app` service for local-dev because that
container intentionally uses production settings. API and Web must run in
separate terminals.

```powershell
docker compose -f apps/api/docker-compose.yml up -d postgres
```

Alternatively, run a local PostgreSQL instance matching the `DB_*` values in
`apps/api/.env`.

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

On Windows PowerShell:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000,3001 | Select-Object LocalAddress,LocalPort,OwningProcess
Get-Process -Id <OwningProcess>
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
indicator and `ApiClient` sends no Authorization header. A non-loopback Web API
configuration instead shows an explicit configuration error. Provider failure
still fails closed; the application never substitutes a production mock response.

This mode validates one fixed local user only. It is suitable for Profile,
private-thread and browser-to-Agent smoke tests, but cannot prove the three-user
invite, consent and unanimous-confirmation Hero Journey. Run that acceptance
flow using three real Cognito test accounts.

Return both applications to Cognito mode by removing the ignored local-dev
overrides or setting `AUTH_MODE=cognito` and `NEXT_PUBLIC_AUTH_MODE=cognito`.
Remove `LOCAL_DEV_ALLOWED_ORIGINS` when it is no longer needed.
