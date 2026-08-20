import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AuditAction } from '../../src/domain/audit';
import type {
  IInstallationRepository,
  InstallationRecord,
} from '../../src/domain/licensing/repositories/installation.repository';
import { LicenseIssue, LicenseState } from '../../src/domain/licensing/license-status';
import {
  installationIdOf,
  type InstallationId,
} from '../../src/domain/licensing/value-objects/installation-id';
import type { IHostFingerprintReader } from '../../src/domain/licensing/host-fingerprint-reader.port';
import { InMemoryAuditLogRepository, InMemoryLicenseRepository } from '../../src/infrastructure/persistence/in-memory';
import { Ed25519LicenseTokenVerifier } from '../../src/infrastructure/licensing/ed25519-license-token-verifier';
import type { TrustedSigningKey } from '../../src/infrastructure/licensing/trusted-keys';
import { RecordAuditEntryUseCase } from '../../src/application/audit';
import {
  ActivateLicenseUseCase,
  GetActivationRequestUseCase,
  GetLicenseStatusUseCase,
  LicenseRejectionReason,
} from '../../src/application/licensing';

const FIXTURES = join(__dirname, '../../../../tools/license-generator/test/fixtures');
const INSTALLATION = '11111111-2222-4333-8444-555555555555';
const BOARD = 'a'.repeat(64);
const MACHINE = 'b'.repeat(64);

function testKey(): TrustedSigningKey {
  const [keyId, publicKeyDerB64] = readFileSync(join(FIXTURES, 'test-public-key.txt'), 'utf8')
    .trim()
    .split(/\s+/);
  return { keyId, publicKeyDerB64 };
}

/** Mints a real, correctly signed licence — the same bytes the vendor tool produces. */
function signLicense(overrides: Record<string, unknown> = {}): string {
  const privateKey = createPrivateKey(readFileSync(join(FIXTURES, 'test-signing-key.pem'), 'utf8'));
  const header = { alg: 'Ed25519', kid: testKey().keyId, v: 1 };
  const payload = {
    licenseId: '7f3c1d2e-9a4b-4c5d-8e6f-0a1b2c3d4e5f',
    issuedAt: '2026-01-01T00:00:00.000Z',
    customer: { name: 'Toko Uji', ref: null },
    product: { id: 'qms', majorVersion: 1 },
    type: 'perpetual',
    installationId: INSTALLATION,
    expiresAt: null,
    supportUntil: '2030-01-01T23:59:59.999Z',
    host: { bind: true, claims: { boardUuid: BOARD, machineId: MACHINE }, weights: { boardUuid: 2, machineId: 1 } },
    entitlements: { maxCounters: 8, maxCategories: 10, features: [] },
    grace: { expiryDays: 14, mismatchDays: 30 },
    ...overrides,
  };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = cryptoSign(null, Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'), privateKey);
  return [
    '-----BEGIN QMS LICENSE-----',
    `${headerB64}.${payloadB64}.${signature.toString('base64url')}`,
    '-----END QMS LICENSE-----',
    '',
  ].join('\n');
}

/** Installation repo with a pinned id, so licences can be minted against it. */
class FixedInstallationRepository implements IInstallationRepository {
  public record: InstallationRecord;

  constructor(id: InstallationId, lastSeenAt: Date) {
    this.record = { installationId: id, createdAt: lastSeenAt, lastSeenAt, hostMismatchSince: null };
  }

  async getOrCreate(): Promise<InstallationRecord> {
    return this.record;
  }

  async touch(seenAt: Date): Promise<void> {
    if (seenAt.getTime() > this.record.lastSeenAt.getTime()) {
      this.record = { ...this.record, lastSeenAt: seenAt };
    }
  }

  async setHostMismatchSince(since: Date | null): Promise<void> {
    this.record = { ...this.record, hostMismatchSince: since };
  }
}

class StubFingerprintReader implements IHostFingerprintReader {
  constructor(public claims: Record<string, string> = { boardUuid: BOARD, machineId: MACHINE }) {}
  async read(): Promise<Readonly<Record<string, string>>> {
    return this.claims;
  }
}

const NOW = new Date('2026-06-01T00:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function harness(options: { now?: Date; lastSeenAt?: Date } = {}) {
  const installations = new FixedInstallationRepository(
    installationIdOf(INSTALLATION),
    options.lastSeenAt ?? new Date('2026-01-01T00:00:00.000Z'),
  );
  const licenses = new InMemoryLicenseRepository();
  const auditLog = new InMemoryAuditLogRepository();
  const fingerprints = new StubFingerprintReader();
  // The REAL verifier with a test key — not a fake. The Ed25519 path is the
  // part most likely to break silently, so it stays under test here too.
  const verifier = new Ed25519LicenseTokenVerifier([testKey()]);

  const getStatus = new GetLicenseStatusUseCase(
    installations,
    licenses,
    verifier,
    fingerprints,
    () => (options.now ?? NOW).getTime(),
  );
  const activate = new ActivateLicenseUseCase(
    licenses,
    verifier,
    getStatus,
    undefined,
    new RecordAuditEntryUseCase(auditLog),
  );

  return { installations, licenses, auditLog, fingerprints, getStatus, activate };
}

describe('GetLicenseStatusUseCase', () => {
  it('reports a fresh install as RESTRICTED/ABSENT while still minting an installation id', () => {
    return harness()
      .getStatus.execute()
      .then((result) => {
        expect(result.status.state).toBe(LicenseState.RESTRICTED);
        expect(result.status.issue).toBe(LicenseIssue.ABSENT);
        expect(result.installationId.toString()).toBe(INSTALLATION);
      });
  });

  it('reports a stored, matching licence as VALID', async () => {
    const h = harness();
    await h.licenses.activate(signLicense(), 'manager1');
    const { status } = await h.getStatus.execute();
    expect(status.state).toBe(LicenseState.VALID);
    expect(status.customerName).toBe('Toko Uji');
  });

  it('reports a stored licence that no longer verifies as INVALID, not ABSENT', async () => {
    const h = harness();
    await h.licenses.activate(signLicense().replace(/eyJ/, 'eyK'), 'manager1');
    const { status } = await h.getStatus.execute();
    expect(status.issue).toBe(LicenseIssue.INVALID);
  });

  describe('clock-rollback defence', () => {
    it('keeps an expired trial expired when the mini PC clock is wound back', async () => {
      // No NTP offline, so the wall clock is the customer's to set. The
      // high-water mark is the only thing that makes expiry monotonic.
      const h = harness({ now: days(-90), lastSeenAt: days(0) });
      await h.licenses.activate(
        signLicense({ type: 'trial', supportUntil: null, expiresAt: days(-30).toISOString() }),
        'manager1',
      );
      const { status } = await h.getStatus.execute();
      expect(status.state).toBe(LicenseState.RESTRICTED);
      expect(status.issue).toBe(LicenseIssue.EXPIRED);
    });

    it('advances the high-water mark but never moves it backwards', async () => {
      const h = harness({ now: days(-90), lastSeenAt: days(0) });
      await h.getStatus.execute();
      expect(h.installations.record.lastSeenAt).toEqual(days(0));

      const forward = harness({ now: days(5), lastSeenAt: days(0) });
      await forward.getStatus.execute();
      expect(forward.installations.record.lastSeenAt).toEqual(days(5));
    });
  });

  describe('host-mismatch window', () => {
    it('opens the window on the first mismatch and reports grace, not restriction', async () => {
      const h = harness();
      await h.licenses.activate(signLicense(), 'manager1');
      h.fingerprints.claims = { boardUuid: 'c'.repeat(64), machineId: 'd'.repeat(64) };

      const { status } = await h.getStatus.execute();
      expect(status.state).toBe(LicenseState.MISMATCH_GRACE);
      expect(h.installations.record.hostMismatchSince).toEqual(NOW);
    });

    it('restricts once the recorded window has elapsed', async () => {
      const h = harness();
      await h.licenses.activate(signLicense(), 'manager1');
      h.fingerprints.claims = { boardUuid: 'c'.repeat(64), machineId: 'd'.repeat(64) };
      await h.installations.setHostMismatchSince(days(-45));

      const { status } = await h.getStatus.execute();
      expect(status.state).toBe(LicenseState.RESTRICTED);
      expect(status.issue).toBe(LicenseIssue.HOST_MISMATCH);
    });

    it('clears the window when the host matches again, restoring the full grace', async () => {
      // A store that failed while a bind-mount was missing must get its whole
      // window back once it is restored, not resume a stale countdown.
      const h = harness();
      await h.licenses.activate(signLicense(), 'manager1');
      await h.installations.setHostMismatchSince(days(-45));

      const { status } = await h.getStatus.execute();
      expect(status.state).toBe(LicenseState.VALID);
      expect(h.installations.record.hostMismatchSince).toBeNull();
    });

    it('clears the window when the host becomes unreadable rather than leaving it open', async () => {
      const h = harness();
      await h.licenses.activate(signLicense(), 'manager1');
      await h.installations.setHostMismatchSince(days(-45));
      h.fingerprints.claims = {};

      const { status } = await h.getStatus.execute();
      expect(status.state).toBe(LicenseState.VALID);
      expect(h.installations.record.hostMismatchSince).toBeNull();
    });
  });
});

describe('ActivateLicenseUseCase', () => {
  it('accepts a licence issued for this installation and reports it VALID', async () => {
    const h = harness();
    const result = await h.activate.execute({ token: signLicense(), actor: 'manager1' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.state).toBe(LicenseState.VALID);
    expect(await h.licenses.getActive()).not.toBeNull();
  });

  it('records the activation under the authenticated principal, never a literal', async () => {
    const h = harness();
    await h.activate.execute({ token: signLicense(), actor: 'manager1' });

    const entries = await h.auditLog.list();
    const activated = entries.find((e) => e.action === AuditAction.LICENSE_ACTIVATED);
    expect(activated?.actor).toBe('manager1');
  });

  it('never writes the token itself into the audit log', async () => {
    // Any admin can read the audit log, and the token is the bearer credential
    // for this entitlement.
    const h = harness();
    const token = signLicense();
    await h.activate.execute({ token, actor: 'manager1' });

    const entries = await h.auditLog.list();
    expect(JSON.stringify(entries)).not.toContain('BEGIN QMS LICENSE');
    expect(JSON.stringify(entries)).not.toContain(token.split('\n')[1]);
  });

  it('rejects a licence issued for a different installation', async () => {
    const h = harness();
    const result = await h.activate.execute({
      token: signLicense({ installationId: '99999999-8888-4777-a666-555555555555' }),
      actor: 'manager1',
    });

    expect(result).toMatchObject({ ok: false, reason: LicenseRejectionReason.WRONG_INSTALLATION });
    expect(await h.licenses.getActive()).toBeNull();
  });

  it('rejects an edited licence as UNTRUSTED', async () => {
    const h = harness();
    const lines = signLicense().split('\n');
    const [header, payload, signature] = lines[1].split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload, 'base64url').toString()) as object),
        entitlements: { maxCounters: 999, maxCategories: 999, features: [] },
      }),
    ).toString('base64url');

    const result = await h.activate.execute({
      token: ['-----BEGIN QMS LICENSE-----', `${header}.${forged}.${signature}`, '-----END QMS LICENSE-----'].join('\n'),
      actor: 'manager1',
    });

    expect(result).toMatchObject({ ok: false, reason: LicenseRejectionReason.UNTRUSTED });
  });

  it('rejects a file that is not a licence at all', async () => {
    const result = await harness().activate.execute({ token: 'halo pak', actor: 'manager1' });
    expect(result).toMatchObject({ ok: false, reason: LicenseRejectionReason.MALFORMED });
  });

  it('audits a rejection, because repeated rejections are what tampering looks like', async () => {
    const h = harness();
    await h.activate.execute({ token: 'halo pak', actor: 'manager1' });

    const entries = await h.auditLog.list();
    expect(entries.some((e) => e.action === AuditAction.LICENSE_REJECTED)).toBe(true);
  });

  it('replaces the previous licence rather than accumulating active ones', async () => {
    const h = harness();
    await h.activate.execute({ token: signLicense(), actor: 'manager1' });
    await h.activate.execute({
      token: signLicense({ licenseId: '8a3c1d2e-9a4b-4c5d-8e6f-0a1b2c3d4e5f', customer: { name: 'Toko Baru', ref: null } }),
      actor: 'manager1',
    });

    const history = await h.licenses.history();
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.isActive)).toHaveLength(1);
    const { status } = await h.getStatus.execute();
    expect(status.customerName).toBe('Toko Baru');
  });
});

describe('GetActivationRequestUseCase', () => {
  it('emits one prefixed blob carrying the installation id and the host claims', async () => {
    const h = harness();
    const request = await new GetActivationRequestUseCase(h.getStatus).execute();

    expect(request.blob.startsWith('QMSREQ1-')).toBe(true);
    const decoded = JSON.parse(
      Buffer.from(request.blob.slice('QMSREQ1-'.length), 'base64url').toString('utf8'),
    );
    expect(decoded).toEqual({
      v: 1,
      installationId: INSTALLATION,
      claims: { boardUuid: BOARD, machineId: MACHINE },
      majorVersion: 1,
    });
  });

  it('carries only digests, never a raw hardware identifier', async () => {
    const h = harness();
    const request = await new GetActivationRequestUseCase(h.getStatus).execute();
    for (const value of Object.values(request.claims)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('produces byte-identical bytes to the generator\'s committed golden.req', async () => {
    // The activation-request format has two independent implementations, same
    // as the licence token. This is its drift gate: core-api emits the blob,
    // the vendor CLI decodes it, and nothing else would notice them diverging
    // until a customer's activation stopped working — on the very first step,
    // before any licence exists to fall back on.
    const installations = new FixedInstallationRepository(
      installationIdOf('11111111-2222-4333-8444-555555555555'),
      NOW,
    );
    const claim = (name: string, value: string) =>
      createHash('sha256').update(`${name}:${value}`).digest('hex');
    const fingerprints = new StubFingerprintReader({
      boardUuid: claim('boardUuid', '4c4c4544-0037-5a10-8054-b7c04f4d5632'),
      machineId: claim('machineId', 'd9f1a0c4b7e2436fa1c8e5d3b60947fe'),
    });
    const getStatus = new GetLicenseStatusUseCase(
      installations,
      new InMemoryLicenseRepository(),
      new Ed25519LicenseTokenVerifier([testKey()]),
      fingerprints,
      () => NOW.getTime(),
    );

    const request = await new GetActivationRequestUseCase(getStatus).execute();

    expect(request.blob).toBe(readFileSync(join(FIXTURES, 'golden.req'), 'utf8').trim());
  });

  it('still produces a usable request on a host with no fingerprint mounts', async () => {
    // The vendor can then issue with --no-bind-host; the installation id alone
    // is enough to bind a licence.
    const h = harness();
    h.fingerprints.claims = {};
    const request = await new GetActivationRequestUseCase(h.getStatus).execute();

    expect(request.claims).toEqual({});
    expect(request.installationId).toBe(INSTALLATION);
  });
});
