import { describe, expect, it } from "vitest";
import { databaseConnectionOptions } from "../src/db/connection-options.js";

describe("databaseConnectionOptions", () => {
  it("keeps local development compatible when SSL is not requested", () => {
    expect(databaseConnectionOptions({})).toEqual({});
    expect(databaseConnectionOptions({ DB_SSL_MODE: "disable" })).toEqual({});
  });

  it("enables encrypted PostgreSQL transport for RDS", () => {
    expect(databaseConnectionOptions({ DB_SSL_MODE: " require " })).toEqual({ ssl: "require" });
  });

  it("fails closed for an unsupported mode", () => {
    expect(() => databaseConnectionOptions({ DB_SSL_MODE: "prefer" })).toThrow(
      "DB_SSL_MODE must be either 'disable' or 'require'",
    );
  });
});
