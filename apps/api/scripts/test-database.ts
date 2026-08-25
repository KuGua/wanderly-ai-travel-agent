const DEFAULT_TEST_DATABASE_URL =
  "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function resolveTestDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

export function assertDisposableTestDatabase(connectionString: string): URL {
  const parsed = new URL(connectionString);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const schemaName = readSearchPath(parsed);

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("Refusing test database access: host must be loopback");
  }
  if (
    !/^[A-Za-z0-9_]+_test$/.test(databaseName)
    && !/^[A-Za-z0-9_]+_test$/.test(schemaName ?? "")
  ) {
    throw new Error(
      "Refusing test database access: database name or search_path schema must end in _test",
    );
  }

  return parsed;
}

export function readTestSchema(connectionString: URL): string | null {
  return readSearchPath(connectionString);
}

function readSearchPath(connectionString: URL): string | null {
  const options = connectionString.searchParams.get("options") ?? "";
  const match = /(?:^|\s)-c\s*search_path=([A-Za-z0-9_]+)/.exec(options);
  return match?.[1] ?? null;
}
