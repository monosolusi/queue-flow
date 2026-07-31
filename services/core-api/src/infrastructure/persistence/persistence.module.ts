import { type DynamicModule, Module } from '@nestjs/common';
import { InMemoryPersistenceModule } from './in-memory/in-memory-persistence.module';
import { PostgresPersistenceModule } from './postgres';

/**
 * Binds the repository concretions to their domain port tokens (DIP): the
 * application layer depends on the tokens, this infrastructure module supplies
 * the implementations. {@link PersistenceModule.forRoot} selects the profile
 * from `QMS_PERSISTENCE`:
 *
 * - `'in-memory'` (default) — {@link InMemoryPersistenceModule}: the in-memory
 *   repositories + the no-op `NoOpTransactionManager` + the dev-only
 *   `DevSeedService` (seeds sample data only when `QMS_DEV_SEED=1`). Used by
 *   unit/integration tests and local dev; data is lost on restart.
 * - `'postgres'` — {@link PostgresPersistenceModule}: the PostgreSQL
 *   repositories + `PostgresTransactionManager` (atomic reserve+save,
 *   NFR-REL-02) + the boot migration runner. `DevSeedService` is **excluded**
 *   here — the wizard is the real seed, and the dev seed would write a sample
 *   config that prevents the first-run redirect (FR-WZD-01).
 *
 * Both profiles are **static `@Module`s**, so NestJS deduplicates a single
 * instance across every importer of `PersistenceModule`. Returning fresh
 * provider objects per `forRoot()` call would create one repository instance
 * per importer — the tests seed config into one instance while the
 * `StateTransitionValidator` reads another, producing `SYSTEM_NOT_CONFIGURED`.
 * Re-exporting the static modules keeps one shared singleton set.
 */
@Module({})
export class PersistenceModule {
  static forRoot(): DynamicModule {
    const profile = process.env.QMS_PERSISTENCE === 'postgres'
      ? PostgresPersistenceModule
      : InMemoryPersistenceModule;

    return {
      module: PersistenceModule,
      imports: [profile],
      exports: [profile],
    };
  }
}