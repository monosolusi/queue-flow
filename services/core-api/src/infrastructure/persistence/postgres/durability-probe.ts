import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_CONNECTION } from './postgres-connection.provider';
import { DurabilityDegradedException } from './durability-degraded.exception';

/**
 * Boot-time durability contract probe (QUE-28 / NFR-REL-02). The postgres
 * profile's gap-free sequence guarantee relies on committed writes surviving a
 * power cut. {@link PostgresTransactionManager} wraps reserve+save in one
 * transaction and {@link PostgresSequenceRepository} enlists on it — but that
 * only helps if the database actually flushes WAL to disk before reporting
 * commit success.
 *
 * Two durability levers, handled by code/config:
 *  - `synchronous_commit=on` is **enforced** per connection by {@link
 *    createPgPool}'s `onConnect` hook (a `user`-context GUC, set per session),
 *    so the app's commits wait for WAL flush regardless of the server default.
 *  - `fsync=on` is a `postmaster`-context GUC (settable only at server restart),
 *    so it cannot be enforced per-session; this probe **verifies** it at boot
 *    and refuses to start if it is off.
 *
 * Fail-fast is the correct posture for a hard reliability constraint: a queue
 * that could silently lose or gap ticket numbers must not boot. This probe,
 * following the schema migration (`PostgresMigrationRunner`), is the "startup
 * recovery flow" — confirming the store is safe to serve before it accepts a
 * single ticket.
 *
 * Infrastructure only: it owns boot I/O (a framework `OnModuleInit` hook +
 * `pg`), so it must not live in domain or application (NFR-MNT-01).
 */
@Injectable()
export class PostgresDurabilityProbe implements OnModuleInit {
  private readonly logger = new Logger(PostgresDurabilityProbe.name);

  constructor(@Inject(PG_CONNECTION) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    const { rows } = await this.pool.query<{ fsync: string }>('SHOW fsync');
    const fsync = rows[0].fsync;
    if (fsync !== 'on') {
      throw new DurabilityDegradedException('fsync', fsync);
    }
    this.logger.log(
      'Startup recovery: durability contract verified (fsync=on; synchronous_commit=on enforced per-connection).',
    );
  }
}