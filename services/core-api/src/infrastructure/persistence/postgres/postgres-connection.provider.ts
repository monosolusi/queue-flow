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
  const base = connectionString
    ? { connectionString }
    : {
        host: process.env.PGHOST ?? 'db-service',
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER ?? 'postgres',
        password: process.env.PGPASSWORD ?? 'postgres',
        database: process.env.PGDATABASE ?? 'qms',
      };
  return new Pool({
    ...base,
    // Enforce commit durability per connection (QUE-28 / NFR-REL-02).
    // `synchronous_commit` is a `user`-context GUC, so `SET` persists for the
    // connection session — every pooled commit waits for WAL flush regardless
    // of the server default. `pg-pool` awaits `onConnect` before handing the
    // client out (and destroys it on rejection), so no checkout sees a
    // connection without the GUC applied. `fsync` is `postmaster`-context and
    // cannot be set per-session — it is verified at boot by
    // {@link PostgresDurabilityProbe}.
    onConnect: async (client) => {
      await client.query('SET synchronous_commit=on');
    },
  });
}