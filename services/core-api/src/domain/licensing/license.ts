import { Entity } from '../shared/entity';
import { InvalidValueObjectException } from '../shared/errors';
import { Identifier } from '../shared/identifier';
import { Entitlements } from './value-objects/entitlements';
import { HostFingerprint } from './value-objects/host-fingerprint';
import { InstallationId, installationIdOf } from './value-objects/installation-id';
import { LicenseType, licenseTypeOf } from './value-objects/license-type';

/** Grace windows, in days, when a licence does not state its own. */
export const DEFAULT_GRACE_EXPIRY_DAYS = 14;
/**
 * Longer than the expiry window on purpose. With no subscription tier, a host
 * mismatch is the ONLY thing that can restrict a paying perpetual customer, so
 * a false positive here — a replaced motherboard, a bind-mount dropped during
 * maintenance — bills straight to support. 30 days is enough for someone to
 * notice the banner and get a replacement licence issued.
 */
export const DEFAULT_GRACE_MISMATCH_DAYS = 30;

/** How close to expiry the UI starts warning. */
export const EXPIRING_SOON_DAYS = 30;

export interface LicenseCustomer {
  readonly name: string;
  readonly ref: string | null;
}

/**
 * A licence, reconstituted from the payload of a token whose signature has
 * ALREADY been verified.
 *
 * Construction is deliberately downstream of verification: this class trusts
 * its input, and the only thing allowed to produce that input is
 * `ILicenseTokenVerifier`. Parsing an unverified payload into a `License` would
 * make a forged token indistinguishable from a real one everywhere downstream.
 *
 * Immutable. A licence is issued by the vendor, never edited by the store —
 * which is why it lives in its own bounded context rather than alongside the
 * manager-editable `SystemConfiguration`.
 */
export class License extends Entity<Identifier> {
  private constructor(
    id: Identifier,
    private readonly props: {
      readonly issuedAt: Date;
      readonly customer: LicenseCustomer;
      readonly productId: string;
      readonly majorVersion: number;
      readonly type: LicenseType;
      readonly installationId: InstallationId;
      readonly expiresAt: Date | null;
      readonly supportUntil: Date | null;
      readonly host: HostFingerprint;
      readonly entitlements: Entitlements;
      readonly graceExpiryDays: number;
      readonly graceMismatchDays: number;
    },
  ) {
    super(id);
  }

  /**
   * @param raw the decoded payload of a token whose signature already verified.
   * @throws InvalidValueObjectException when the payload is not a licence we
   *   understand — which, post-verification, means we issued something malformed
   *   or the token version moved without this code moving with it.
   */
  public static fromPayload(raw: unknown): License {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `license payload must be a plain object, got '${String(raw)}'`,
      );
    }
    const p = raw as Record<string, unknown>;

    const product =
      p.product !== null && typeof p.product === 'object' && !Array.isArray(p.product)
        ? (p.product as Record<string, unknown>)
        : {};
    const majorVersion = product.majorVersion;
    if (typeof majorVersion !== 'number' || !Number.isInteger(majorVersion) || majorVersion < 1) {
      throw new InvalidValueObjectException(
        `license product.majorVersion must be a positive integer, got '${String(majorVersion)}'`,
      );
    }

    const grace =
      p.grace !== null && typeof p.grace === 'object' && !Array.isArray(p.grace)
        ? (p.grace as Record<string, unknown>)
        : {};

    const type = licenseTypeOf(p.type);
    const expiresAt = readInstant(p.expiresAt, 'expiresAt', true);
    const supportUntil = readInstant(p.supportUntil, 'supportUntil', true);
    assertWindowMatchesType(type, expiresAt, supportUntil);

    if (typeof p.licenseId !== 'string' || p.licenseId.length === 0) {
      throw new InvalidValueObjectException('license licenseId is required');
    }

    return new License(Identifier.of(p.licenseId), {
      issuedAt: readInstant(p.issuedAt, 'issuedAt', false) as Date,
      customer: readCustomer(p.customer),
      productId: typeof product.id === 'string' ? product.id : 'qms',
      majorVersion,
      type,
      installationId: installationIdOf(String(p.installationId)),
      expiresAt,
      supportUntil,
      host: HostFingerprint.of(p.host),
      entitlements: assertCapsMatchType(type, Entitlements.of(p.entitlements)),
      graceExpiryDays: readDays(grace.expiryDays, 'grace.expiryDays', DEFAULT_GRACE_EXPIRY_DAYS),
      graceMismatchDays: readDays(
        grace.mismatchDays,
        'grace.mismatchDays',
        DEFAULT_GRACE_MISMATCH_DAYS,
      ),
    });
  }

  public get issuedAt(): Date { return this.props.issuedAt; }
  public get customer(): LicenseCustomer { return this.props.customer; }
  public get productId(): string { return this.props.productId; }
  public get majorVersion(): number { return this.props.majorVersion; }
  public get type(): LicenseType { return this.props.type; }
  public get installationId(): InstallationId { return this.props.installationId; }
  public get expiresAt(): Date | null { return this.props.expiresAt; }
  public get supportUntil(): Date | null { return this.props.supportUntil; }
  public get host(): HostFingerprint { return this.props.host; }
  public get entitlements(): Entitlements { return this.props.entitlements; }
  public get graceExpiryDays(): number { return this.props.graceExpiryDays; }
  public get graceMismatchDays(): number { return this.props.graceMismatchDays; }

  /** True when this licence was issued for `installationId`. */
  public isFor(installationId: InstallationId): boolean {
    return this.props.installationId.equals(installationId);
  }
}

/**
 * The per-type window rules, enforced HERE as well as in the generator.
 *
 * This is the one duplication that belongs on both sides of the boundary. The
 * generator must reject a bad combination at issue time, with a message aimed
 * at the vendor. But the golden-fixture twin gate only proves "what the
 * generator mints, core-api accepts" — it says nothing about the reverse, and
 * the reverse fails SILENTLY: a mis-issued `trial` with no `expiresAt` was a
 * perpetual licence in disguise, and a mis-issued `perpetual` carrying an
 * `expiresAt` could brick a paying customer offline with no way to appeal.
 * Only the vendor can sign, so the exposure is vendor error — which is exactly
 * the error nothing else was checking for.
 */
function assertWindowMatchesType(
  type: LicenseType,
  expiresAt: Date | null,
  supportUntil: Date | null,
): void {
  if (type === LicenseType.PERPETUAL) {
    if (expiresAt !== null) {
      throw new InvalidValueObjectException('a perpetual license must not carry an expiresAt');
    }
    if (supportUntil === null) {
      throw new InvalidValueObjectException('a perpetual license requires a supportUntil');
    }
    return;
  }
  if (type === LicenseType.TRIAL) {
    if (expiresAt === null) {
      throw new InvalidValueObjectException('a trial license requires an expiresAt');
    }
    if (supportUntil !== null) {
      throw new InvalidValueObjectException('a trial license must not carry a supportUntil');
    }
    return;
  }
  // FREE: no end date of any kind. Its limits are entitlements, not time.
  if (supportUntil !== null) {
    throw new InvalidValueObjectException('a free license must not carry a supportUntil');
  }
  if (expiresAt !== null) {
    throw new InvalidValueObjectException('a free license must not carry an expiresAt');
  }
}

/**
 * The free tier is DEFINED by its caps. Without one it grants exactly what a
 * perpetual licence grants, minus the support window — which is not something
 * anyone sells, and would mean a mis-issued free licence silently became the
 * most generous tier. Mirrors the generator's issue-time rule.
 */
function assertCapsMatchType(type: LicenseType, entitlements: Entitlements): Entitlements {
  if (
    type === LicenseType.FREE &&
    entitlements.maxCounters === null &&
    entitlements.maxCategories === null
  ) {
    throw new InvalidValueObjectException(
      'a free license requires at least one entitlement cap (maxCounters or maxCategories)',
    );
  }
  return entitlements;
}

function readCustomer(raw: unknown): LicenseCustomer {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidValueObjectException(
      `license customer must be a plain object, got '${String(raw)}'`,
    );
  }
  const customer = raw as Record<string, unknown>;
  if (typeof customer.name !== 'string' || customer.name.trim().length === 0) {
    throw new InvalidValueObjectException('license customer.name must be a non-empty string');
  }
  return {
    name: customer.name.trim(),
    ref: typeof customer.ref === 'string' && customer.ref.length > 0 ? customer.ref : null,
  };
}

function readInstant(raw: unknown, field: string, nullable: boolean): Date | null {
  if (raw === null || raw === undefined) {
    if (nullable) return null;
    throw new InvalidValueObjectException(`license ${field} is required`);
  }
  if (typeof raw !== 'string') {
    throw new InvalidValueObjectException(
      `license ${field} must be an ISO-8601 string, got '${String(raw)}'`,
    );
  }
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) {
    throw new InvalidValueObjectException(`license ${field} is not a valid date: '${raw}'`);
  }
  return instant;
}

function readDays(raw: unknown, field: string, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  throw new InvalidValueObjectException(
    `license ${field} must be a non-negative integer, got '${String(raw)}'`,
  );
}
