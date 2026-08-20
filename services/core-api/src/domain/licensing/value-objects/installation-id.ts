import { Identifier } from '../../shared/identifier';

/**
 * The identity of THIS installation of QMS — the hard binding a licence is
 * issued against.
 *
 * Generated once, on first boot, and persisted. It is deliberately NOT derived
 * from hardware: it travels with a database restore and survives an upgrade,
 * so a customer who replaces a failed mini PC and restores their backup keeps
 * working. (Atlassian's Server ID makes the same trade for the same reason.)
 *
 * That portability is also its weakness — copying the `pgdata` volume copies
 * this id too. {@link HostFingerprint} is the soft binding that covers exactly
 * that gap; neither is sufficient alone.
 */
export type InstallationId = Identifier & { readonly __brand: 'InstallationId' };

export function installationIdOf(value: string): InstallationId {
  return Identifier.of(value) as InstallationId;
}

export function installationIdGenerate(): InstallationId {
  return Identifier.generate() as InstallationId;
}
