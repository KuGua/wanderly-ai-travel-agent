import type postgres from "postgres";

type PostgresOptions = NonNullable<Parameters<typeof postgres>[1]>;

/**
 * Keep local PostgreSQL friction-free while requiring an explicit deployment
 * choice for encrypted connections. Unknown values fail closed at startup.
 */
export function databaseConnectionOptions(
  environment: NodeJS.ProcessEnv = process.env,
): Pick<PostgresOptions, "ssl"> {
  const mode = environment.DB_SSL_MODE?.trim().toLowerCase();
  if (!mode || mode === "disable") return {};
  if (mode === "require") return { ssl: "require" };
  throw new Error("DB_SSL_MODE must be either 'disable' or 'require'");
}
