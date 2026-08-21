import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
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
  GetLicenseStatusUseCase,
  LicenseRejectionReason,
} from '../../src/application/licensing';
import {
  ActivationTransportFailure,
  type ActivationRedemption,
  type ILicenseActivationClient,
  type RedemptionResult,
} from '../../src/domain/licensing/license-activation-client.port';

const FIXTURES = join(__dirname, '../../../../tools/license-format/test/fixtures');
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

/**
 * A key whose check symbol is correct, so it reaches the network stage. Built
 * by the same arithmetic the activation server uses, not by calling the VO —
 * a fixture derived from the implementation cannot detect a broken one.
 */
function validKey(payload = 'M4RS7QRSTVWXYZ0123A'): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) sum += alphabet.indexOf(payload[i]) * (2 * i + 1);
  const full = payload + alphabet[sum % 32];
  return `${full.slice(0, 5)}-${full.slice(5, 10)}-${full.slice(10, 15)}-${full.slice(15)}`;
}

const KEY = validKey();

/**
 * Stands in for the vendor's activation server. Records what it was asked, so
 * the tests can assert that the installation id and host claims actually reach
 * the party that has to bind them.
 */
class StubActivationClient implements ILicenseActivationClient {
  public readonly calls: ActivationRedemption[] = [];
  public reply: RedemptionResult;

  constructor(reply: RedemptionResult) {
    this.reply = reply;
  }

  async redeem(request: ActivationRedemption): Promise<RedemptionResult> {
    this.calls.push(request);
    return this.reply;
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
  const activation = new StubActivationClient({ ok: true, armoredToken: signLicense() });
  const activate = new ActivateLicenseUseCase(
    licenses,
    verifier,
    activation,
    getStatus,
    undefined,
    new RecordAuditEntryUseCase(auditLog),
  );

  return { installations, licenses, auditLog, fingerprints, getStatus, activate, activation };
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

describe('ActivateLicenseUseCase — redeeming a key', () => {
  it('redeems the key and reports the licence VALID', async () => {
    const h = harness();
    const result = await h.activate.execute({ key: KEY, actor: 'manager1' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.state).toBe(LicenseState.VALID);
    expect(await h.licenses.getActive()).not.toBeNull();
  });

  it('sends the installation id and host claims the server needs to bind the licence', async () => {
    const h = harness();
    await h.activate.execute({ key: KEY, actor: 'manager1' });

    expect(h.activation.calls).toHaveLength(1);
    expect(h.activation.calls[0]).toEqual({
      key: KEY,
      installationId: INSTALLATION,
      claims: { boardUuid: BOARD, machineId: MACHINE },
      productId: 'qms',
      majorVersion: 1,
    });
  });

  it('normalises the key before sending it, so the server sees one canonical form', async () => {
    const h = harness();
    await h.activate.execute({ key: `  ${KEY.replace(/-/g, '').toLowerCase()}  `, actor: 'manager1' });

    expect(h.activation.calls[0].key).toBe(KEY);
  });

  it('records the activation under the authenticated principal, never a literal', async () => {
    const h = harness();
    await h.activate.execute({ key: KEY, actor: 'manager1' });

    const entries = await h.auditLog.list();
    const activated = entries.find((e) => e.action === AuditAction.LICENSE_ACTIVATED);
    expect(activated?.actor).toBe('manager1');
  });

  it('writes neither the token nor the full key into the audit log', async () => {
    // Any admin can read the audit log. The token is the bearer credential for
    // this entitlement, and the key is what mints one.
    const h = harness();
    const token = signLicense();
    h.activation.reply = { ok: true, armoredToken: token };
    await h.activate.execute({ key: KEY, actor: 'manager1' });

    const dumped = JSON.stringify(await h.auditLog.list());
    expect(dumped).not.toContain('BEGIN QMS LICENSE');
    expect(dumped).not.toContain(token.split('\n')[1]);
    expect(dumped).not.toContain(KEY);
    // Enough left to match a support conversation to a row, and no more.
    expect(dumped).toContain(KEY.split('-')[3]);
  });
});

describe('ActivateLicenseUseCase — the key never left the building', () => {
  it('rejects a mistyped key WITHOUT calling the activation server', async () => {
    // The whole point of the check symbol. A slipped finger must not cost a
    // network round trip, and must not burn a redemption attempt against a
    // customer whose key was fine all along.
    const h = harness();
    const mistyped = KEY.slice(0, -1) + (KEY.endsWith('0') ? '1' : '0');

    const result = await h.activate.execute({ key: mistyped, actor: 'manager1' });

    expect(result).toMatchObject({ ok: false, reason: LicenseRejectionReason.KEY_MALFORMED });
    expect(h.activation.calls).toHaveLength(0);
    expect(await h.licenses.getActive()).toBeNull();
  });

  it('rejects an empty or nonsense key without calling out', async () => {
    const h = harness();
    for (const key of ['', 'halo pak', 'QMS-1234']) {
      const result = await h.activate.execute({ key, actor: 'manager1' });
      expect(result).toMatchObject({ ok: false, reason: LicenseRejectionReason.KEY_MALFORMED });
    }
    expect(h.activation.calls).toHaveLength(0);
  });
});

describe('ActivateLicenseUseCase — the server said no', () => {
  it.each([
    [ActivationTransportFailure.OFFLINE, LicenseRejectionReason.OFFLINE],
    [ActivationTransportFailure.TIMEOUT, LicenseRejectionReason.TIMEOUT],
    [ActivationTransportFailure.SERVER_ERROR, LicenseRejectionReason.SERVER_ERROR],
    [ActivationTransportFailure.KEY_UNKNOWN, LicenseRejectionReason.KEY_UNKNOWN],
    [ActivationTransportFailure.KEY_ALREADY_USED, LicenseRejectionReason.KEY_ALREADY_USED],
    [ActivationTransportFailure.KEY_REVOKED, LicenseRejectionReason.KEY_REVOKED],
    [ActivationTransportFailure.KEY_EXPIRED, LicenseRejectionReason.KEY_EXPIRED],
    [ActivationTransportFailure.PRODUCT_MISMATCH, LicenseRejectionReason.WRONG_PRODUCT],
  ])('maps transport %s to rejection %s', async (failure, expected) => {
    // Every transport outcome keeps its own identity all the way to the screen.
    // Collapsing them is the failure mode that sends a technician hunting for a
    // dead network when the real answer is "that key belongs to another shop".
    const h = harness();
    h.activation.reply = { ok: false, failure, detail: 'x' };

    const result = await h.activate.execute({ key: KEY, actor: 'manager1' });

    expect(result).toMatchObject({ ok: false, reason: expected });
    expect(await h.licenses.getActive()).toBeNull();
  });

  it('audits a rejection, because repeated rejections are what tampering looks like', async () => {
    const h = harness();
    h.activation.reply = {
      ok: false,
      failure: ActivationTransportFailure.KEY_UNKNOWN,
      detail: 'no such key',
    };
    await h.activate.execute({ key: KEY, actor: 'manager1' });

    const entries = await h.auditLog.list();
    expect(entries.some((e) => e.action === AuditAction.LICENSE_REJECTED)).toBe(true);
  });
});

describe('ActivateLicenseUseCase — the server is not trusted just for answering', () => {
  it('rejects a token signed by a key this build does not know', async () => {
    // THE test for the whole online design. If a reply were trusted because of
    // where it came from, repointing QMS_LICENSE_ACTIVATION_URL at a homemade
    // server would mint free licences. It must not.
    const h = harness();
    const foreignKey = createPrivateKey(
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    );
    const header = { alg: 'Ed25519', kid: testKey().keyId, v: 1 };
    const payload = JSON.parse(
      Buffer.from(signLicense().split('\n')[1].split('.')[1], 'base64url').toString('utf8'),
    ) as object;
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const forged = cryptoSign(
      null,
      Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
      foreignKey,
    );
    h.activation.reply = {
      ok: true,
      armoredToken: [
        '-----BEGIN QMS LICENSE-----',
        `${headerB64}.${payloadB64}.${forged.toString('base64url')}`,
        '-----END QMS LICENSE-----',
      ].join('\n'),
    };

    const result = await h.activate.execute({ key: KEY, actor: 'manager1' });

    expect(result).toMatchObject({ ok: false, reason: LicenseRejectionReason.UNTRUSTED });
    expect(await h.licenses.getActive()).toBeNull();
  });

  it('rejects a token the server tampered with after signing', async () => {
    const h = harness();
    const [header, payload, signature] = signLicense().split('\n')[1].split('.');
    const inflated = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload, 'base64url').toString()) as object),
        entitlements: { maxCounters: 999, maxCategories: 999, features: [] },
      }),
    ).toString('base64url');
    h.activation.reply = {
      ok: true,
      armoredToken: [
        '-----BEGIN QMS LICENSE-----',
        `${header}.${inflated}.${signature}`,
        '-----END QMS LICENSE-----',
      ].join('\n'),
    };

    const result = await h.activate.execute({ key: KEY, actor: 'manager1' });
    expect(result).toMatchObject({ ok: false, reason: LicenseRejectionReason.UNTRUSTED });
  });

  it('rejects a token issued for a different installation', async () => {
    const h = harness();
    h.activation.reply = {
      ok: true,
      armoredToken: signLicense({ installationId: '99999999-8888-4777-a666-555555555555' }),
    };

    const result = await h.activate.execute({ key: KEY, actor: 'manager1' });

    expect(result).toMatchObject({ ok: false, reason: LicenseRejectionReason.WRONG_INSTALLATION });
    expect(await h.licenses.getActive()).toBeNull();
  });

  it('rejects a reply that is not a licence at all', async () => {
    const h = harness();
    h.activation.reply = { ok: true, armoredToken: 'halo pak' };

    const result = await h.activate.execute({ key: KEY, actor: 'manager1' });
    expect(result).toMatchObject({ ok: false, reason: LicenseRejectionReason.MALFORMED });
  });
});

describe('ActivateLicenseUseCase — re-activation after the vendor releases a seat', () => {
  it('replaces the previous licence rather than accumulating active ones', async () => {
    // This is what makes vendor-side deactivation work with no client-side
    // button: the customer simply redeems again, and the swap is one
    // transaction with no window in which the store has no licence at all.
    const h = harness();
    await h.activate.execute({ key: KEY, actor: 'manager1' });
    h.activation.reply = {
      ok: true,
      armoredToken: signLicense({
        licenseId: '8a3c1d2e-9a4b-4c5d-8e6f-0a1b2c3d4e5f',
        customer: { name: 'Toko Baru', ref: null },
      }),
    };
    await h.activate.execute({ key: KEY, actor: 'manager1' });

    const history = await h.licenses.history();
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.isActive)).toHaveLength(1);
    const { status } = await h.getStatus.execute();
    expect(status.customerName).toBe('Toko Baru');
  });

  it('clears an open host-mismatch window, so replacement hardware starts clean', async () => {
    const h = harness();
    await h.activate.execute({ key: KEY, actor: 'manager1' });
    await h.installations.setHostMismatchSince(days(-45));

    await h.activate.execute({ key: KEY, actor: 'manager1' });

    expect(h.installations.record.hostMismatchSince).toBeNull();
  });

  it('leaves the existing licence untouched when a re-activation is refused', async () => {
    // A failed re-activation must not be a way to lose a working licence.
    const h = harness();
    await h.activate.execute({ key: KEY, actor: 'manager1' });
    h.activation.reply = {
      ok: false,
      failure: ActivationTransportFailure.OFFLINE,
      detail: 'no route to host',
    };

    await h.activate.execute({ key: KEY, actor: 'manager1' });

    const { status } = await h.getStatus.execute();
    expect(status.state).toBe(LicenseState.VALID);
    expect((await h.licenses.history()).filter((row) => row.isActive)).toHaveLength(1);
  });
});
