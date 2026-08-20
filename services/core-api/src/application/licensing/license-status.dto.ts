import type { EntitlementsDto } from '../../domain/licensing/value-objects/entitlements';
import { restrictsNewTickets, type LicenseStatus } from '../../domain/licensing/license-status';

/**
 * Compact slice carried on the PUBLIC `GET /api/system/config`.
 *
 * Every frontend already fetches that endpoint at boot, so adding a field here
 * reaches all four PWAs with no new endpoint and no new auth surface — the same
 * route `brandColor` and `printerConfiguration` took.
 *
 * Deliberately narrow. Entitlement caps, the customer reference and the host
 * verdict are administrative detail and stay on `/api/license`; what an
 * unauthenticated kiosk needs is only enough to render a banner and know
 * whether it may still issue a ticket.
 */
export interface LicenseSummaryDto {
  state: string;
  issue: string;
  /** English diagnostic. Frontends render their own Indonesian copy from `state`/`issue`. */
  detail: string;
  expiresAt: string | null;
  graceEndsAt: string | null;
  restrictsNewTickets: boolean;
}

/** Full projection, for the admin licence screen. */
export interface LicenseStatusDto extends LicenseSummaryDto {
  type: string | null;
  customerName: string | null;
  supportUntil: string | null;
  daysUntilExpiry: number | null;
  supportActive: boolean;
  versionCovered: boolean;
  entitlements: EntitlementsDto;
  host: {
    outcome: string;
    matchedWeight: number;
    recordedWeight: number;
    requiredWeight: number;
    changed: string[];
    unreadable: string[];
  } | null;
}

export function licenseSummary(status: LicenseStatus): LicenseSummaryDto {
  return {
    state: status.state,
    issue: status.issue,
    detail: status.detail,
    expiresAt: status.expiresAt?.toISOString() ?? null,
    graceEndsAt: status.graceEndsAt?.toISOString() ?? null,
    restrictsNewTickets: restrictsNewTickets(status),
  };
}

export function licenseStatusToDto(status: LicenseStatus): LicenseStatusDto {
  return {
    ...licenseSummary(status),
    type: status.type,
    customerName: status.customerName,
    supportUntil: status.supportUntil?.toISOString() ?? null,
    daysUntilExpiry: status.daysUntilExpiry,
    supportActive: status.supportActive,
    versionCovered: status.versionCovered,
    entitlements: status.entitlements.toDto(),
    host:
      status.fingerprint === null
        ? null
        : {
            outcome: status.fingerprint.outcome,
            matchedWeight: status.fingerprint.matchedWeight,
            recordedWeight: status.fingerprint.recordedWeight,
            requiredWeight: status.fingerprint.requiredWeight,
            // Claim NAMES only. The digests stay server-side: they are not
            // secret, but publishing them hands anyone building a clone the
            // exact values to reproduce.
            changed: [...status.fingerprint.changed],
            unreadable: [...status.fingerprint.unreadable],
          },
  };
}
