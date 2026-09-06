# API workflow test isolation failure

## Incident

The `apps-api` GitHub Actions workflow at commit
`e29718ebebe87a301da4ca61093d637030f88d57` passed dependency installation,
type checking, linting, documentation verification, and migrations, then failed
the test step with 8 failures across 2 files.

## Root causes

`chat-conversation-e2e.test.ts` submitted `I am considering Tokyo and Kyoto`
while asserting that an explicit destination confirmation cue was persisted.
The destination preflight now correctly treats that sentence as exploration and
does not call the model classifier, so the restored cue was `null`. The fixture
now sends an explicit `Set Tokyo as the destination` command; the stubbed model
still returns two candidates because this test covers persistence and settlement,
not natural-language classification.

`trip-draft-brief.test.ts` deleted all audit events, conversations, memberships,
and trips before every case. The Vitest configuration intentionally uses one
fork and one disposable PostgreSQL schema for the full run. A preceding suite
left a valid `provider_offers` row referencing its constraint snapshot, so the
global trip deletion violated `provider_offers_snapshot_id_fkey`. The first
hook failure was then repeated for all seven cases. Cleanup now tracks the trips
created by this suite and removes only their audit events and trip graphs after
each case.

## Verification

Run the two regression files together first:

```sh
cd apps/api
npm test -- tests/chat-conversation-e2e.test.ts tests/trip-draft-brief.test.ts
```

Then reproduce the workflow locally in its declared order:

```sh
cd apps/api
npm ci
npm run typecheck
npm run lint
npm run docs:verify
npm run db:migrate
npm test
```

The tests use only the disposable `travelagent_test` schema guarded by
`scripts/test-database.ts`; no production or developer database is eligible.
