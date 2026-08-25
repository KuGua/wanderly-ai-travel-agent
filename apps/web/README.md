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

For the complete local browser-to-Agent setup, see
[`docs/local-development-auth.md`](../../docs/local-development-auth.md).

Copy `.env.example` to `.env.local` and select one data mode:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
NEXT_PUBLIC_AUTH_MODE=cognito
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
- Before Cognito is available, a strictly local Web dev server may set
  `NEXT_PUBLIC_AUTH_MODE=local-dev` only while the API uses its loopback-only
  `AUTH_MODE=local-dev`. The browser sends no fake bearer token or user ID and
  displays an explicit Local Development indicator.

All responses pass through the same Zod schemas. `NEXT_PUBLIC_*` values are
bundled into browser code and must never contain credentials, private Profile
data, or a private map token.

The default style is OpenFreeMap Liberty. It requires attribution, which the
Explore map exposes through MapLibre's attribution control. OpenFreeMap does
not provide an availability SLA, so deployment acceptance must include that
risk or configure another approved provider. The Explore page keeps an
accessible destination list if the map cannot load.

Before MapLibre initializes, the Explore page inserts the public-domain GEBCO
global shaded-relief WMS beneath OpenFreeMap's vector details. GEBCO provides
one opaque land-and-seabed texture, so terrain depth does not depend on a
transparent SVG tint. Liberty's `natural_earth` raster remains underneath as a
visual fallback if GEBCO is unavailable; roads, labels and administrative
layers stay above both rasters. GEBCO requires attribution, has no availability
SLA, and explicitly must not be used for navigation or safety at sea.

For low-zoom global country borders, the Explore page also loads the
versioned local file `public/map-data/natural-earth-admin-0.geojson` as a
SVG overlay above the provider stack. The browser fetches this same-origin
asset, culls coordinates on the globe's back hemisphere, and projects the
remaining paths with the active camera. It is derived from Natural Earth Admin
0 Countries, appears in the attribution control, and is never used for
destination lookup or travel facts. State/province and city details remain
progressive OpenFreeMap style layers.

## Run locally

Keep Fastify on port 3000 and run Web on port 3001:

```bash
npm install
npm run dev -- --port 3001
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
