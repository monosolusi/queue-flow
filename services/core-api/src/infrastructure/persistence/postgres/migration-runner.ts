import { Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { PG_CONNECTION } from './postgres-connection.provider';

/**
 * Applies idempotent SQL migrations at boot (QUE-30). Migrations live in
 * `migrations/*.sql` next to this file, applied in lexical (filename) order.
 * Each applied migration is recorded in a `_migrations` table with its SHA-256
 * checksum; on restart, already-applied migrations are skipped (checksum
 * verified) so re-running is safe. This is the only schema authority — no
 * Prisma/TypeORM — keeping the dependency surface minimal and `pg` confined to
 * infrastructure (NFR-MNT-01).
 *
 * `OnModuleInit` runs before `app.listen`, so the schema is ready before the
 * HTTP server accepts traffic.
 */
@Injectable()
export class PostgresMigrationRunner implements OnModuleInit {
  constructor(@Inject(PG_CONNECTION) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    const migrationsDir = join(__dirname, 'migrations');
    let files: string[] = [];
    try {
      files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    } catch {
      // No migrations dir — nothing to apply.
      return;
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const { rows } = await this.pool.query<{ checksum: string }>(
        'SELECT checksum FROM _migrations WHERE filename = $1',
        [file],
      );
      if (rows.length > 0) {
        if (rows[0].checksum !== checksum) {
          throw new Error(
            `Migration '${file}' checksum mismatch — applied migration was modified.`,
          );
        }
        continue; // already applied, unchanged
      }
      await this.pool.query(sql);
      await this.pool.query(
        'INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)',
        [file, checksum],
      );
    }
  }
}