import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { IHostFingerprintReader } from '../../domain/licensing/host-fingerprint-reader.port';
import { isUsableClaimValue } from '../../domain/licensing/value-objects/host-fingerprint';

export interface ClaimSource {
  readonly name: string;
  readonly path: string;
}

/**
 * Where each host claim is read from INSIDE the container. The host paths are
 * bind-mounted read-only by `docker-compose.prod.yml`:
 *
 *   /sys/class/dmi/id/product_uuid -> /host/board-uuid   (motherboard identity)
 *   /etc/machine-id                -> /host/machine-id   (OS install identity)
 *
 * The container's OWN `/etc/machine-id` is useless — Docker does not populate
 * it consistently — and the container's MAC address is regenerated on every
 * recreate, which is precisely why the MAC-based approach used by some
 * enterprise licences cannot be copied here. The host's `/etc/machine-id` is
 * written once by systemd at OS install and is stable across reboots, container
 * rebuilds and image upgrades.
 *
 * `product_uuid` is mode 0400 root:root; core-api's Dockerfile declares no
 * `USER`, so the process runs as root and can read it. Adding a `USER` line
 * would silently reduce this claim to unreadable — and, because unreadable is
 * not a mismatch, would silently weaken host binding rather than break loudly.
 *
 * Deliberately NOT read: `board_serial` / `product_serial`. The mini PCs this
 * ships on routinely report `"Default string"` there, and while
 * `isUsableClaimValue` would reject that, reading them at all invites someone
 * to trust them later.
 */
export const DEFAULT_CLAIM_SOURCES: readonly ClaimSource[] = [
  { name: 'boardUuid', path: process.env.QMS_HOST_BOARD_UUID_PATH ?? '/host/board-uuid' },
  { name: 'machineId', path: process.env.QMS_HOST_MACHINE_ID_PATH ?? '/host/machine-id' },
];

/**
 * Reads host claims from bind-mounted kernel files.
 *
 * Values must be read live from the kernel, never from a file an installer
 * wrote: a file the installer populated would be copied along with everything
 * else when someone clones the deployment, which is the one scenario host
 * binding exists to catch.
 *
 * **This never throws.** Every failure mode — the mount missing, Docker having
 * auto-created a directory where a file was expected (EISDIR), a permission
 * error, a non-Linux host — resolves to "claim absent". The policy reads a
 * fully-absent fingerprint as UNAVAILABLE and does not block on it, so a
 * forgotten volume degrades host binding instead of taking a shop offline.
 */
export class SysfsHostFingerprintReader implements IHostFingerprintReader {
  private readonly sources: readonly ClaimSource[];

  constructor(sources: readonly ClaimSource[] = DEFAULT_CLAIM_SOURCES) {
    this.sources = sources;
  }

  public async read(): Promise<Readonly<Record<string, string>>> {
    const claims: Record<string, string> = {};
    for (const source of this.sources) {
      const raw = readIfPossible(source.path);
      if (raw === null || !isUsableClaimValue(raw)) {
        continue;
      }
      claims[source.name] = hashClaim(source.name, raw);
    }
    return claims;
  }
}

/**
 * The digest a claim is recorded and compared as. Namespaced by claim name so
 * two claims that happen to hold the same raw string do not produce the same
 * digest — and so a digest can never be replayed under a different claim name.
 *
 * Exported because the activation flow has to hash exactly the same way when it
 * builds the request the vendor signs; the generator does the same in
 * `test/fixtures/make-golden.mjs`.
 */
export function hashClaim(name: string, rawValue: string): string {
  return createHash('sha256').update(`${name}:${rawValue.trim()}`).digest('hex');
}

function readIfPossible(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
