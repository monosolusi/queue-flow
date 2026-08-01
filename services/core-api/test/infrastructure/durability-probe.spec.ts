import { Logger } from '@nestjs/common';
import { PostgresDurabilityProbe } from '../../src/infrastructure/persistence/postgres/durability-probe';
import { DurabilityDegradedException } from '../../src/infrastructure/persistence/postgres/durability-degraded.exception';

/**
 * A minimal `pg.Pool` stand-in: only `query('SHOW fsync')` is exercised by the
 * probe, so the fake answers that one query with the configured `fsync` value.
 * Keeps the unit gate DB-free (NFR-REL-02 contract verified without a real PG).
 */
function fakePool(fsync: string) {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ fsync }] }),
  };
}

describe('PostgresDurabilityProbe (QUE-28 / NFR-REL-02)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Restore the spied Logger methods so call counts don't accumulate across
    // tests (jest config has no `restoreMocks`).
    jest.restoreAllMocks();
  });

  it('resolves and logs when fsync=on (durability contract satisfied)', async () => {
    const pool = fakePool('on');
    const probe = new PostgresDurabilityProbe(pool as never);
    await expect(probe.onModuleInit()).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledWith('SHOW fsync');
    expect(Logger.prototype.log).toHaveBeenCalledTimes(1);
  });

  it('fails fast with DurabilityDegradedException when fsync=off', async () => {
    const pool = fakePool('off');
    const probe = new PostgresDurabilityProbe(pool as never);
    await expect(probe.onModuleInit()).rejects.toBeInstanceOf(DurabilityDegradedException);
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('fails fast when fsync is any non-on value (e.g. a future PG default)', async () => {
    const pool = fakePool('local'); // a hypothetical remote-recycle GUC value
    const probe = new PostgresDurabilityProbe(pool as never);
    await expect(probe.onModuleInit()).rejects.toBeInstanceOf(DurabilityDegradedException);
  });

  it('surfaces the offending setting + value in the message', async () => {
    const pool = fakePool('off');
    const probe = new PostgresDurabilityProbe(pool as never);
    await expect(probe.onModuleInit()).rejects.toThrow(/fsync=off/);
  });
});