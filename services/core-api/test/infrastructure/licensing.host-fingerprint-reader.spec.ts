import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SysfsHostFingerprintReader,
  hashClaim,
} from '../../src/infrastructure/licensing/sysfs-host-fingerprint-reader';

describe('SysfsHostFingerprintReader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qms-fingerprint-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sourcesIn = (names: string[]) => names.map((name) => ({ name, path: join(dir, name) }));

  function write(name: string, contents: string): void {
    writeFileSync(join(dir, name), contents, 'utf8');
  }

  it('hashes each readable claim, namespaced by claim name', () => {
    write('boardUuid', '4c4c4544-0037-5a10-8054-b7c04f4d5632\n');
    write('machineId', 'd9f1a0c4b7e2436fa1c8e5d3b60947fe\n');

    return new SysfsHostFingerprintReader(sourcesIn(['boardUuid', 'machineId']))
      .read()
      .then((claims) => {
        expect(claims).toEqual({
          boardUuid: hashClaim('boardUuid', '4c4c4544-0037-5a10-8054-b7c04f4d5632'),
          machineId: hashClaim('machineId', 'd9f1a0c4b7e2436fa1c8e5d3b60947fe'),
        });
      });
  });

  it('never emits a raw hardware identifier', async () => {
    const raw = '4c4c4544-0037-5a10-8054-b7c04f4d5632';
    write('boardUuid', raw);

    const claims = await new SysfsHostFingerprintReader(sourcesIn(['boardUuid'])).read();
    expect(Object.values(claims)).not.toContain(raw);
    expect(claims.boardUuid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('namespaces the digest so the same value under two claim names differs', () => {
    // Otherwise a digest read for one claim could be replayed as another.
    expect(hashClaim('boardUuid', 'same-value-here')).not.toBe(hashClaim('machineId', 'same-value-here'));
  });

  it('ignores surrounding whitespace, so /etc/machine-id\'s trailing newline is irrelevant', () => {
    write('machineId', '  d9f1a0c4b7e2436fa1c8e5d3b60947fe  \n');
    return new SysfsHostFingerprintReader(sourcesIn(['machineId']))
      .read()
      .then((claims) =>
        expect(claims.machineId).toBe(hashClaim('machineId', 'd9f1a0c4b7e2436fa1c8e5d3b60947fe')),
      );
  });

  /**
   * The mini-PC-specific hazard: a placeholder must be OMITTED, never hashed.
   * A digest of "Default string" is indistinguishable from a digest of a real
   * serial, so every unit of that model would match every other one — the
   * fingerprint would certify a clone instead of catching it.
   */
  it.each([
    ['Default string'],
    ['To be filled by O.E.M.'],
    ['00000000-0000-0000-0000-000000000000'],
    ['03000200-0400-0500-0006-000700080009'],
    [''],
    ['   '],
  ])('omits the firmware placeholder %p entirely', async (value) => {
    write('boardUuid', value);
    const claims = await new SysfsHostFingerprintReader(sourcesIn(['boardUuid'])).read();
    expect(claims).toEqual({});
  });

  it('omits a claim whose file does not exist', async () => {
    write('machineId', 'd9f1a0c4b7e2436fa1c8e5d3b60947fe');
    const claims = await new SysfsHostFingerprintReader(sourcesIn(['boardUuid', 'machineId'])).read();
    expect(Object.keys(claims)).toEqual(['machineId']);
  });

  /**
   * Docker creates a DIRECTORY at the target when a bind-mount source file is
   * missing on the host — the exact shape of a mis-provisioned mini PC. Reading
   * it raises EISDIR, which must degrade to "absent" rather than crash the boot.
   */
  it('omits a claim whose path is a directory (the missing-bind-mount shape)', async () => {
    mkdirSync(join(dir, 'boardUuid'));
    const claims = await new SysfsHostFingerprintReader(sourcesIn(['boardUuid'])).read();
    expect(claims).toEqual({});
  });

  it('returns an empty map, and does not reject, when nothing is readable at all', async () => {
    // A dev laptop or a host with no fingerprint mounts. The policy reads this
    // as UNAVAILABLE and does not block — taking a shop offline over a
    // forgotten volume would be the worst possible failure mode.
    await expect(
      new SysfsHostFingerprintReader(sourcesIn(['boardUuid', 'machineId'])).read(),
    ).resolves.toEqual({});
  });
});
