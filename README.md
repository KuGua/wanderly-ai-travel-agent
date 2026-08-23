# AI Travel Agent

Hackathon MVP for consent-based shared international-trip planning.

## Repository layout

- `apps/api/` — TypeScript/Fastify backend MVP, PostgreSQL schema, fixtures and tests. `apps/` is the conventional monorepo location for deployable applications; `api` is the backend service.
- `docs/` — product requirements, delivery backlog and test scenarios.

## Run the backend

```bash
cd apps/api
npm install
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

The API is available at `http://localhost:3000`; OpenAPI documentation is at `/docs`.
See [the backend README](apps/api/README.md), [architecture](apps/api/ARCHITECTURE.md), and [API reference](apps/api/API.md) for details.
