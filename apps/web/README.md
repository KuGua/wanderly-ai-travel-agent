# Wanderly Web

Next.js 16 App Router frontend for the AI Travel Agent Hackathon. The current
slice contains a globe-first Explore page, My program, Travel preference, a
shared responsive rail, the unified API client, and contract-validated local
fixtures.

## Routes

- `/` redirects directly to `/home`.
- `/home` is the interactive Explore globe.
- `/projects` is My program and displays the confirmed Trip List fields only.
- `/profile` is Travel preference and retains Profile GET/PUT editing.

There is no seeded-user selector. Production identity comes from the account
control's Cognito User Pool sign-in using a registered email address or phone
number. AWS Amplify manages the browser session and refresh; protected API calls
read the current access token at request time and send
`Authorization: Bearer <token>`. Clients never send a user ID.

## Configuration

Copy `.env.example` to `.env.local` and select one data mode:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-east-1_example
NEXT_PUBLIC_COGNITO_CLIENT_ID=example-public-app-client-id
NEXT_PUBLIC_DATA_MODE=fixture
NEXT_PUBLIC_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
```

- `fixture` uses one deterministic, contract-validated example workspace and
  visibly labels API-backed surfaces `Demo data`.
- `api` calls Fastify at `${NEXT_PUBLIC_API_BASE_URL}/api/v1`. The Cognito app
  client must be a public browser client without a client secret and must match
  the API's `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` configuration for private
  features. The offline map location-reference call is the sole anonymous API call;
  it works without Cognito and returns no persisted user data.

All responses pass through the same Zod schemas. `NEXT_PUBLIC_*` values are
bundled into browser code and must never contain credentials, private Profile
data, or a private map token.

The default style is OpenFreeMap Liberty. It requires attribution, which the
Explore map exposes through MapLibre's attribution control. OpenFreeMap does
not provide an availability SLA, so deployment acceptance must include that
risk or configure another approved provider. The Explore page keeps an
accessible destination list if the map cannot load.

For low-zoom global country borders, the Explore page also loads the
versioned local file `public/map-data/natural-earth-admin-0.geojson` as a
SVG overlay. The browser fetches this same-origin asset and projects its paths
with the active map camera, rather than routing it through MapLibre's
GeoJSON-source worker. It is derived from Natural Earth Admin 0 Countries and is
shown in the same attribution control; it is a visual fallback only and is
never used for destination lookup or travel facts. State/province and city
details remain progressive OpenFreeMap layers, appearing at their style zoom
thresholds.

## Run locally

Keep Fastify on port 3000 and run Web on port 3001:

```bash
npm install
npm run dev -- -p 3001
```

Open `http://localhost:3001`; it redirects to the globe.

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Current boundary

Trip cards contain only fields supported by `GET /api/v1/trips`. The Trip
detail route is an explicit placeholder. Destination suggestions are local UI
fixtures, not live travel claims. Agent chat, arbitrary-place enrichment,
consent, planning, visa/readiness, replan, confirmation, booking, Profile
creation/deletion and advanced Cognito challenges such as MFA remain separate slices.
`PUT /profiles/me` cannot create a missing Profile or clear nullable values
under the current backend contract.
