import type { Pool } from 'pg';

/**
 * NestJS DI token for the shared `pg.Pool` (QUE-30). The pool is the single
 * connection authority for the PostgreSQL profile; every Postgres repository
 * and the {@link PostgresTransactionManager} inject it from here. Infrastructure
 * only — `pg` never leaks into domain or application (NFR-MNT-01, enforced by
 * dep-cruiser's `domain-no-framework-imports`).
 */
export const PG_CONNECTION = Symbol('PG_CONNECTION');

/**
 * Builds a `pg.Pool` from the environment. The connection string is read from
 * `QMS_DB_URL` (preferred) or the standard `PG*` env vars (`pg` falls back to
 * them). Defaults suit the single-host Docker compose layout
 * (`db-service:5432/qms`). Kept as a plain factory (not a class) so the
 * {@link PostgresPersistenceModule} can provide `{ provide: PG_CONNECTION,
 * useFactory: createPgPool }`.
 */
export function createPgPool(): Pool {
  // Lazy require keeps `pg` out of any file the domain/application layers touch.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as typeof import('pg');
  const connectionString = process.env.QMS_DB_URL;
  return new Pool(
    connectionString
      ? { connectionString }
      : {
          host: process.env.PGHOST ?? 'db-service',
          port: Number(process.env.PGPORT ?? 5432),
          user: process.env.PGUSER ?? 'postgres',
          password: process.env.PGPASSWORD ?? 'postgres',
          database: process.env.PGDATABASE ?? 'qms',
        },
  );
}