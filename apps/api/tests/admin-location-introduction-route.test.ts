import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/db/database.js";
import { users } from "../src/db/schema.js";
import { verifyTestAccessToken } from "./helpers/auth.js";
import { buildApp } from "../src/app.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const NON_OPERATOR_ID = "22222222-2222-4222-8222-222222222222";

const app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
await app.ready();

const SAMPLE_BODY = {
  sourceId: "vienna-2",
  canonicalPlaceId: "vienna-2-at",
  name: "Vienna 2",
  country: "Austria",
  countryCode: "AT",
  admin1: "Vienna",
  admin1Code: "AT-9",
  nearestCity: "Vienna",
  nearestCityLongitude: 16.3738,
  nearestCityLatitude: 48.2082,
};

const previousAdmins = process.env.LOCATION_INTRODUCTION_ADMIN_USER_IDS;
const previousSubjects = process.env.LOCATION_INTRODUCTION_ADMIN_SUBJECTS;

beforeAll(async () => {
  await db.execute(sql`DELETE FROM audit_events WHERE actor_user_id IN (${OPERATOR_ID}, ${NON_OPERATOR_ID})`);
  await db.execute(sql`DELETE FROM location_introduction_catalog_overrides`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${OPERATOR_ID}, ${NON_OPERATOR_ID})`);
  await db.insert(users).values([
    { id: OPERATOR_ID, externalId: "test-operator", displayName: "Test Operator" },
    { id: NON_OPERATOR_ID, externalId: "test-anon", displayName: "Test Anon" },
  ]);
  // Use the subject allow-list so the test helper's `test-alice` JWT
  // (which maps to subject "alice") matches; the route's user row then
  // resolves via the users.externalId check.
  process.env.LOCATION_INTRODUCTION_ADMIN_SUBJECTS = "alice,bob,chen";
  delete process.env.LOCATION_INTRODUCTION_ADMIN_USER_IDS;
});

afterEach(async () => {
  await db.execute(sql`DELETE FROM location_introduction_catalog_overrides`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM audit_events WHERE actor_user_id IN (${OPERATOR_ID}, ${NON_OPERATOR_ID})`);
  await db.execute(sql`DELETE FROM location_introduction_catalog_overrides`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${OPERATOR_ID}, ${NON_OPERATOR_ID})`);
  if (previousAdmins !== undefined) process.env.LOCATION_INTRODUCTION_ADMIN_USER_IDS = previousAdmins;
  else delete process.env.LOCATION_INTRODUCTION_ADMIN_USER_IDS;
  if (previousSubjects !== undefined) process.env.LOCATION_INTRODUCTION_ADMIN_SUBJECTS = previousSubjects;
  else delete process.env.LOCATION_INTRODUCTION_ADMIN_SUBJECTS;
  await app.close();
});

describe("POST /api/v1/admin/location-introduction/entries", () => {
  it("registers a new entry for an authenticated operator", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/location-introduction/entries",
      headers: { authorization: `Bearer test-alice` },
      payload: SAMPLE_BODY,
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as { sourceId: string; createdByUserId: string };
    expect(json.sourceId).toBe("vienna-2");
    expect(json.createdByUserId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects an unknown sourceId shape with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/location-introduction/entries",
      headers: { authorization: `Bearer test-alice` },
      payload: { ...SAMPLE_BODY, sourceId: "../etc/passwd" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a request without a bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/location-introduction/entries",
      payload: SAMPLE_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an operator not in the allow-list", async () => {
    // Subject "chen" is in the allow-list; "noone" is not. Use a
    // verify token whose subject is not in the list. Verify accepts
    // only test-{alice,bob,chen} so we cannot mint a non-allow-listed
    // subject via the helper. Instead, clear the allow-list and assert
    // the route refuses.
    const previous = process.env.LOCATION_INTRODUCTION_ADMIN_SUBJECTS;
    delete process.env.LOCATION_INTRODUCTION_ADMIN_SUBJECTS;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/location-introduction/entries",
        headers: { authorization: `Bearer test-alice` },
        payload: SAMPLE_BODY,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      process.env.LOCATION_INTRODUCTION_ADMIN_SUBJECTS = previous ?? "alice,bob,chen";
    }
  });
});