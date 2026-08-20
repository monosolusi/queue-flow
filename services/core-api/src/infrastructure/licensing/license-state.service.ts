import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { GetLicenseStatusUseCase } from '../../application/licensing/get-license-status.use-case';
import type { ILicenseStatusProvider } from '../../domain/licensing/license-status-provider.port';
import { LicenseState, type LicenseStatus } from '../../domain/licensing/license-status';
import { FingerprintOutcome } from '../../domain/licensing/value-objects/host-fingerprint';
import { TRUSTED_SIGNING_KEYS } from './trusted-keys';

/** How long a cached evaluation is served before a background refresh. */
export const LICENSE_REFRESH_INTERVAL_MS = 60_000;

/**
 * Holds the current licence verdict in memory.
 *
 * Unlike `BootstrapService`, which deliberately does not cache, this one must:
 * the verdict is consulted on the gateway's access-check subrequest and on every
 * mutating API call, and re-reading the database plus two sysfs files each time
 * would spend the whole NFR-PERF-01 budget on a value that changes at most
 * daily. Every grace boundary is day-granular, so a 60-second cache cannot
 * change any decision — and activation invalidates it immediately, so the
 * screen never shows a stale "not licensed" after a successful upload.
 *
 * The guard reads {@link current} synchronously. That is the point: a per-request
 * await on IO is what the cache exists to avoid.
 */
@Injectable()
export class LicenseStateService
  implements ILicenseStatusProvider, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LicenseStateService.name);
  private status: LicenseStatus | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(GetLicenseStatusUseCase) private readonly getStatus: GetLicenseStatusUseCase,
  ) {}

  /**
   * `onApplicationBootstrap`, NOT `onModuleInit`, and both halves of that matter.
   *
   * Ordering: `PostgresMigrationRunner` creates the `installation` and
   * `licenses` tables from its own `onModuleInit`. Nest runs every
   * `onModuleInit` to completion before the first `onApplicationBootstrap`, so
   * this hook is the only one guaranteed to see a migrated schema. Evaluating
   * from `onModuleInit` raced the runner and failed with
   * `relation "installation" does not exist` on a fresh database.
   *
   * Failure handling: the first evaluation is explicitly allowed to fail. An
   * unhandled rejection here aborts `NestFactory.create`, so a transient
   * database hiccup at boot would turn into a container that never starts and,
   * with `restart: always`, a crash loop — a licensing problem escalated into a
   * total outage. The verdict stays `null` (which the guard reads as "allow")
   * and the interval retries.
   */
  public async onApplicationBootstrap(): Promise<void> {
    // An un-keyed production image cannot activate ANY licence, so every store
    // running it is stuck on the activation screen with no way forward. That is
    // a vendor release error, not a customer one, and it must not be something
    // you discover from a confused shop owner. `npm run verify` refuses to pass
    // a release build in this state; this is the last line of defence.
    if (TRUSTED_SIGNING_KEYS.length === 0 && process.env.NODE_ENV === 'production') {
      this.logger.error(
        'NO TRUSTED SIGNING KEY COMPILED IN — this build cannot activate any license. ' +
          'Run `node tools/license-generator/bin/qms-license.mjs keygen` and paste the printed ' +
          'entry into src/infrastructure/licensing/trusted-keys.ts, then rebuild.',
      );
    }
    try {
      await this.refresh();
    } catch (error) {
      this.logger.error(
        `initial license evaluation failed, retrying in the background: ${(error as Error).message}`,
      );
    }
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {
        // Already logged inside refresh(); swallowing keeps the interval alive.
      });
    }, LICENSE_REFRESH_INTERVAL_MS);
    // Do not hold the event loop open — a timer without this makes tests hang
    // and delays a clean container shutdown.
    this.timer.unref?.();
  }

  public onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * The cached verdict, or `null` before the first evaluation completes.
   *
   * `null` is NOT "restricted". Refusing traffic during the boot window would
   * turn a slow database into a licence failure, and the gateway would bounce
   * every screen to activation while the store was merely starting up.
   */
  public get current(): LicenseStatus | null {
    return this.status;
  }

  public async refresh(): Promise<LicenseStatus> {
    try {
      const { status } = await this.getStatus.execute();
      this.logChange(status);
      this.status = status;
      return status;
    } catch (error) {
      // A licence evaluation that throws must never take down the boot path or
      // the refresh loop. Keep the last known verdict — degrading a working
      // store to restricted because one query failed is the wrong direction.
      this.logger.error(`license evaluation failed: ${(error as Error).message}`);
      if (this.status !== null) return this.status;
      throw error;
    }
  }

  private logChange(next: LicenseStatus): void {
    if (this.status !== null && this.status.state === next.state) return;

    const message = `license: ${next.state} (${next.issue}) — ${next.detail}`;
    if (next.state === LicenseState.RESTRICTED) this.logger.error(message);
    else if (next.state === LicenseState.VALID) this.logger.log(message);
    else this.logger.warn(message);

    // Surfaced separately because it is the single most likely cause of a
    // false host mismatch: the bind-mounts are absent, so binding is silently
    // doing nothing. Better a line in the log than a licence nobody realises
    // is unenforced.
    if (next.fingerprint?.outcome === FingerprintOutcome.UNAVAILABLE && next.fingerprint.recordedWeight > 0) {
      this.logger.warn(
        'license: host claims are unreadable — check the fingerprint bind-mounts in ' +
          'docker-compose.prod.yml. Host binding is not being enforced.',
      );
    }
  }
}
