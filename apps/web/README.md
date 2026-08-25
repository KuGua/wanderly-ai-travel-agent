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

There is no seeded-user selector. Production identity comes from a normal
Cognito sign-in (email/phone configuration belongs to the authentication
integration). Protected API calls accept a Cognito access-token provider and
send `Authorization: Bearer <token>`; clients never send a user ID. The account
button is intentionally a neutral placeholder until the sign-in UI is wired.

## Configuration

Copy `.env.example` to `.env.local` and select one data mode:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
NEXT_PUBLIC_DATA_MODE=fixture
NEXT_PUBLIC_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
```

- `fixture` uses one deterministic, contract-validated example workspace and
  visibly labels API-backed surfaces `Demo data`.
- `api` calls Fastify at `${NEXT_PUBLIC_API_BASE_URL}/api/v1`. A signed-in
  session must provide its Cognito access token to `HttpTravelApi`.

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
creation/deletion, and the Cognito sign-in screen remain separate slices.
`PUT /profiles/me` cannot create a missing Profile or clear nullable values
under the current backend contract.
