# Wanderly Web

Next.js 16 App Router frontend for the AI Travel Agent Hackathon. The current
slice contains a globe-first Explore page, My program, Travel preference, a
shared responsive rail, the unified API client, and contract-validated local
fixtures.

## Routes

- `/` is locale-detected by next-intl and redirects to the locale-aware Explore globe.
- `/en/home` and `/zh/home` are the interactive Explore globe routes.
- `/en/projects` and `/zh/projects` are My program and display the confirmed Trip List fields only.
- `/en/profile` and `/zh/profile` are Travel preference and retain Profile GET/PUT editing.

There is no seeded-user selector. Production identity comes from the account
control's Cognito User Pool sign-in using a registered email address or phone
number. AWS Amplify manages the browser session and refresh; protected API calls
read the current access token at request time and send
`Authorization: Bearer <token>`. Clients never send a user ID.

## Configuration

For the complete local browser-to-Agent setup, see
[`docs/local-development-auth.md`](../../docs/local-development-auth.md).

Copy `.env.example` to `.env.local`. Until Cognito is available, the team's
recommended local baseline is the loopback-only `local-dev` mode:

```bash
NEXT_PUBLIC_AUTH_MODE=local-dev
NEXT_PUBLIC_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
```

- When `NEXT_PUBLIC_API_BASE_URL` is unset, the Web app calls Fastify at the
  same hostname as the page on port `3000`; this is the recommended local and
  trusted-LAN baseline. Set it only for a fixed deployed API origin. `local-dev`
  requires a loopback API URL. `custom-local` may use the matching RFC1918 IPv4
  address for a short-lived trusted-LAN test when that Web Origin is listed in
  the API's `LOCAL_DEV_ALLOWED_ORIGINS`; the browser still sends no user ID.
- When Cognito is available, set `NEXT_PUBLIC_AUTH_MODE=cognito` and configure
  `NEXT_PUBLIC_COGNITO_USER_POOL_ID` / `NEXT_PUBLIC_COGNITO_CLIENT_ID`. The app
  client must be public and match the API configuration. The offline map
  location-reference call remains the sole anonymous API call.

All responses pass through the same Zod schemas. `NEXT_PUBLIC_*` values are
bundled into browser code and must never contain credentials, private Profile
data, or a private map token.

The default style is OpenFreeMap Liberty. It requires attribution, which the
Explore map exposes through MapLibre's attribution control. OpenFreeMap does
not provide an availability SLA, so deployment acceptance must include that
risk or configure another approved provider. The Explore page keeps an
accessible destination list if the map cannot load.

The Explore page immediately renders Liberty's CDN-backed `natural_earth`
raster and a solid water surface, then progressively overlays the public-domain
GEBCO global shaded-relief WMS beneath OpenFreeMap's vector details. GEBCO uses
1024px logical tiles to bound public-WMS request fan-out, while Natural Earth
remains visible, including by overzooming its final source level, if GEBCO or
vector details are unavailable. Roads, labels and administrative layers stay
above both rasters. GEBCO requires attribution, has no availability SLA, and
explicitly must not be used for navigation or safety at sea.

For country borders, the Explore page renders a camera-projected SVG overlay
above the provider stack. `build-country-boundaries.mjs` uses Natural Earth
Admin 0 10m only at build time, turns it into one shared topology, and writes
three local line meshes for progressive zoom loading. The browser loads only
the selected mesh, so neighbouring countries never double-stroke a shared
border. The versioned local China maritime-line asset is rendered separately;
there is no browser DataV data request. These display assets are not used for
destination lookup or travel facts. The overlay culls the globe's back
hemisphere, while state/province boundary details remain progressive OpenFreeMap
style layers.

Globe text is a separate camera-projected SVG overlay backed by the versioned
`public/map-data/geography-labels.geojson` file. It contains compact display-only
points generated from Natural Earth countries, populated places and Admin 1
data, plus the local versioned China province-level display centers. Continents
and countries appear at globe scale, capitals and high-ranking cities at the
next tier, and state/province names when zoomed further. English and Simplified
Chinese routes prefer their matching name and fall back to English. Regenerate
the file deliberately with `node scripts/build-geography-labels.mjs`; the script
records source URLs in the GeoJSON metadata. These labels are never used as
location-reference, travel, legal, booking, visa or navigation facts.

## Run locally

Keep Fastify on port 3000 and run Web on port 3001:

```bash
npm install
npm run dev -- --port 3001
```

Open `http://localhost:3001`; next-intl redirects it to the locale-aware globe.

Durable Conversation development also requires the API and its independent
Worker in separate terminals:

```bash
npm --prefix apps/api run db:migrate
npm --prefix apps/api run dev
npm --prefix apps/api run worker:dev
npm --prefix apps/web run dev -- --port 3001
```

The server-only model settings are `MODEL_GATEWAY_PROVIDER`, `GEMINI_MODEL`,
and `GEMINI_API_KEY`; never add their secret values to `.env.local` or browser
configuration.

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
fixtures, not live travel claims. Owner-only Agent chat uses server-owned
Conversation threads and durable run recovery; streaming text is transient and
the final assistant response is recovered from the server. Arbitrary-place
enrichment, consent, planning, visa/readiness, replan, confirmation, booking,
Profile creation/deletion and advanced Cognito challenges such as MFA remain
separate slices.
`PUT /profiles/me` cannot create a missing Profile or clear nullable values
under the current backend contract.
