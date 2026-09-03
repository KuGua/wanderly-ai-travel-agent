# Local Development Authentication

`AUTH_MODE=local-dev` exists only for a single-user browser → API smoke path.
`AUTH_MODE=custom-local` is the database-backed multi-user mode for isolation,
invitation and private-thread tests. It can also support a short-lived trusted
LAN test over an exact RFC1918 IPv4 address. Cognito remains the default and
the production authentication mechanism.

Local development mode is fail-closed:

- it is rejected unless `NODE_ENV` is `development` or `test`;
- `local-dev` startup and protected requests are rejected unless `HOST` and the
  actual socket peer are loopback (`trustProxy` is not enabled, so forwarded
  client headers do not choose it);
- `custom-local` normally has the same loopback setup, but may bind an exact
  RFC1918 IPv4 address for a trusted LAN test; public, tunnel and wildcard
  bindings remain rejected;
- only explicit loopback Origins may read local-dev API responses. custom-local
  additionally accepts an exact configured RFC1918 IPv4 Origin; protected
  `POST`/`PUT`/`PATCH`/`DELETE` requests also require one of those Origins;
- the server provisions one fixed `local-dev:default-traveler` external subject
  and resolves its database UUID itself;
- bearer tokens, user IDs, demo-user headers and message roles from the browser
  cannot select another identity;
- normal route ownership, authorization, idempotency and persistence checks are
  unchanged.

`custom-local` additionally verifies a database password, issues a signed API
JWT to the browser session, and requires an API-only `JWT_SECRET` of at least
32 characters. It is the recommended mode for local multi-user isolation work.
`local-dev` stays token-free and deliberately represents one fixed user.

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
AUTH_MODE=custom-local
NODE_ENV=development
HOST=127.0.0.1
LOCAL_DEV_ALLOWED_ORIGINS=http://localhost:3001,http://127.0.0.1:3001
JWT_SECRET=<unique-local-secret-at-least-32-characters>
MODEL_GATEWAY_PROVIDER=gemini
MODEL_GATEWAY_API_KEY=<teammate's local Google AI Studio key>
MODEL_GATEWAY_MODEL=gemini-3.1-flash-lite

# apps/web/.env.local
NEXT_PUBLIC_AUTH_MODE=custom-local
```

`LOCAL_DEV_ALLOWED_ORIGINS` is a comma-separated allow-list of exact browser
Origins. Each value must be an `http://` loopback Origin (for example
`http://localhost:3001`), with no path, query or credentials. In `custom-local`
only, it may instead contain the exact RFC1918 IPv4 browser Origin for a
trusted-LAN test. The Web application's browser Origin must match one entry and
its API base URL must use the same private LAN address. Do not add public,
tunnel or deployed URLs, and never use `local-dev` on LAN.

To use one `custom-local` API from both this computer and a trusted LAN device,
bind the API to its private IPv4 address and allow both browser Origins. Leave
`NEXT_PUBLIC_API_BASE_URL` unset so each browser follows the hostname it used
to open the Web app (on API port `3000`). For example,
`LOCAL_DEV_ALLOWED_ORIGINS=http://localhost:3001,http://10.91.182.185:3001`
allows both entry URLs without making a LAN device call its own `localhost`.

The key belongs only in ignored `apps/api/.env`. Never put it in
`apps/web/.env.local`, any `NEXT_PUBLIC_*` variable, source code, tests, logs or
Git. Each teammate may use their own Google AI Studio key. If the team shares a
key, transfer it privately through the team's approved secret-sharing channel,
never through Git, chat screenshots or committed documentation.

## Live tool credentials

The checked-in `apps/api/.env.example` keeps every external credential blank.
The local `.env` selects one provider per mutually exclusive capability and
enables the provider capabilities, but an adapter remains fail-closed until its required
credential is present. The current local baseline selects SerpApi for flights,
Nuitee for priced hotels, OpenRouteService for place/directions,
OpenTripMap for nearby places and non-price accommodation discovery, and Viator
MCP for activities.

| Capability | Required variable(s) | Notes |
| --- | --- | --- |
| Model planning and tool calling | `MODEL_GATEWAY_API_KEY` | Required for all model-backed plans and conversations. The selected provider/model must match the key. |
| Flights | `SERPAPI_API_KEY` | The local baseline selects `FLIGHT_PROVIDER=serpapi`. |
| Transfers (optional) | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET` | Transfers use Amadeus; local development uses `AMADEUS_ENVIRONMENT=test`. |
| Places and directions | `ORS_API_KEY` | One OpenRouteService key enables both tools. |
| Nearby places and accommodation discovery | `OPENTRIPMAP_API_KEY` | This is not priced inventory or availability. |
| Hotel quotes | `NUITEE_API_KEY` | Nuitee also requires per-user nationality authorization before a quote request. |
| Activities | none | The currently integrated Viator MCP endpoint does not use an API key. |

`FLIGHT_PROVIDER` can instead be set to `flightapi` with
`FLIGHTAPI_API_KEY`, or to `amadeus` with `AMADEUS_CLIENT_ID` and
`AMADEUS_CLIENT_SECRET`. For hotels, set
`HOTEL_PROVIDER=serpapi`, `SERPAPI_HOTEL_ENABLED=true`, and
`SERPAPI_HOTEL_API_KEY` to use SerpApi instead of Nuitee. Do not enable two
providers for the same capability: selection is intentionally deterministic.
All listed values are server-only; restart the API and Worker after changing
them. Until a required credential is entered, the relevant tool reports
`UNAVAILABLE/NOT_CONFIGURED` and never uses demo or fixture data.
`MODEL_GATEWAY_TOOL_CALLING_ENABLED=true` and
`PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED=true` enable model tool calls and
personal-conversation tool dispatch respectively. Both require a configured
model gateway and are enabled in the current local setup.

`AUTH_MODE=local-dev` does not disable authorization and does not let the
browser fabricate a token or user ID. The backend supplies one fixed,
development-only, server-owned identity while all normal ownership and
authorization checks remain active. Production continues to use Cognito.

## Trusted LAN test (custom-local only)

Use this only on a network you trust and only while actively testing. Every
participant signs in with their own local account; do not share passwords or
the API JWT. With this machine's address `10.91.182.185`, set:

```dotenv
# apps/api/.env
AUTH_MODE=custom-local
NODE_ENV=development
HOST=10.91.182.185
LOCAL_DEV_ALLOWED_ORIGINS=http://10.91.182.185:3001
JWT_SECRET=<unique-local-secret-at-least-32-characters>

# apps/web/.env.local
NEXT_PUBLIC_AUTH_MODE=custom-local
```

Restart both processes. Start Next.js so it listens on the LAN interface:

```bash
npm --prefix apps/web run dev -- --hostname 0.0.0.0 --port 3001
```

The checked-in `apps/web/next.config.ts` allow-lists `10.91.182.185` for
Next.js development chunks. If the machine's LAN address changes, replace that
single entry with the new private IPv4 address and restart the dev server.

Friends can then open `http://10.91.182.185:3001`. Stop the servers or restore
the loopback settings when the session ends. Do not expose this mode through a
tunnel, router port forwarding, public DNS, or a shared/untrusted Wi-Fi.

## Start the working local stack

Start PostgreSQL before migrations. The repository compose file can run only
the database service; do not start its `app` service for local-dev because that
container intentionally uses production settings. API, durable Agent Worker,
and Web must run in three separate terminals.

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

Start the task Worker in the second terminal. Without this process a submitted
turn correctly remains `QUEUED`; the API request itself never runs the model.

```bash
npm --prefix apps/api run worker:dev
```

Start Web in the third terminal:

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
3. Expect the submitted USER bubble immediately, followed by safety-approved
   streamed text and then the restored final assistant message backed by Gemini.
4. Ask `I'm a Chinese citizen, do I need a visa to go to Tokyo?`.
5. Expect deterministic `SAFE_REFUSAL` behavior with `Verification required`.

In `custom-local` mode, sign in using a database username/password; the browser
stores only its API session token and sends it for protected requests. Sign out
or a new sign-in clears cached private data. In `local-dev` mode the account
control instead shows an explicit local development indicator and `ApiClient`
sends no Authorization header. A non-loopback Web API configuration instead
shows an explicit configuration error. Provider failure
still fails closed; bounded Worker retries preserve the USER message, never
persist a partial ASSISTANT message, and never substitute a production mock
response. Closing the chat or refreshing only disconnects the SSE observer.
Use the visible Stop control to call the explicit cancel endpoint.

`local-dev` validates one fixed local user only. It is suitable for Profile,
private-thread and browser-to-Agent smoke tests, but cannot prove the
three-user invite, consent and unanimous-confirmation Hero Journey.
`custom-local` can exercise that isolation path with three local database
accounts; production acceptance still uses real Cognito test accounts.

Return both applications to Cognito mode by removing the ignored local-dev
overrides or setting `AUTH_MODE=cognito` and `NEXT_PUBLIC_AUTH_MODE=cognito`.
Remove `LOCAL_DEV_ALLOWED_ORIGINS` when it is no longer needed.
