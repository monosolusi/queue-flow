import { GetLicenseStatusUseCase, PRODUCT_MAJOR_VERSION } from './get-license-status.use-case';

/**
 * Prefix on the blob the customer copies off the activation screen. Present so
 * a string pasted into the generator can be recognised — and rejected with a
 * useful message — before anyone tries to base64-decode a WhatsApp message.
 * Must match `ACTIVATION_REQUEST_PREFIX` in tools/license-generator.
 */
export const ACTIVATION_REQUEST_PREFIX = 'QMSREQ1-';

export interface ActivationRequestDto {
  readonly installationId: string;
  /** Claim digests readable on this host. Empty when no fingerprint mount is present. */
  readonly claims: Record<string, string>;
  readonly majorVersion: number;
  /** The single string the customer sends the vendor. */
  readonly blob: string;
}

/**
 * Builds the activation request a customer sends to the vendor.
 *
 * One blob rather than "send me your Installation ID, and also this list of
 * hashes". Both halves have to survive a trip through WhatsApp on someone's
 * phone, and a single prefixed string can be validated as a unit instead of
 * failing later with a mistyped UUID. The vendor pastes it straight into
 * `qms-license issue --request`.
 *
 * Only digests travel, never raw hardware identifiers — the reader hashes at
 * the source, so a customer's board UUID never appears in a chat log or in the
 * licence file that comes back.
 */
export class GetActivationRequestUseCase {
  constructor(
    private readonly getStatus: GetLicenseStatusUseCase,
    private readonly productMajorVersion: number = PRODUCT_MAJOR_VERSION,
  ) {}

  public async execute(): Promise<ActivationRequestDto> {
    const { installationId, observedClaims } = await this.getStatus.execute();

    const payload = {
      v: 1,
      installationId: installationId.toString(),
      claims: { ...observedClaims },
      majorVersion: this.productMajorVersion,
    };

    return {
      installationId: payload.installationId,
      claims: payload.claims,
      majorVersion: payload.majorVersion,
      // `Buffer` is a runtime global, not an import, so this stays inside the
      // application layer's no-framework-imports rule — the same latitude
      // `Identifier.generate()` takes with the WebCrypto global.
      blob: ACTIVATION_REQUEST_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
    };
  }
}
