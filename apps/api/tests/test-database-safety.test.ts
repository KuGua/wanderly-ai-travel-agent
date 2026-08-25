import { describe, expect, it } from "vitest";

import { assertDisposableTestDatabase } from "../scripts/test-database.js";

describe("test database safety guard", () => {
  it("accepts a loopback connection with an isolated _test schema", () => {
    expect(() =>
      assertDisposableTestDatabase(
        "postgres://user:password@127.0.0.1:5432/app?options=-csearch_path%3Dapp_test",
      ),
    ).not.toThrow();
  });

  it("rejects a non-loopback test database", () => {
    expect(() =>
      assertDisposableTestDatabase(
        "postgres://user:password@db.example.com:5432/app_test",
      ),
    ).toThrow("host must be loopback");
  });

  it("rejects a loopback developer database without a _test database or schema", () => {
    expect(() =>
      assertDisposableTestDatabase(
        "postgres://user:password@127.0.0.1:5432/app",
      ),
    ).toThrow("must end in _test");
  });
});
