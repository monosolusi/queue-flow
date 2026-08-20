/**
 * Append-only ledger of every licence ever issued.
 *
 * There is no licence server, so nothing else in the world records what you
 * handed out. Without this file the only copy of "who has what" is the customer's
 * own .lic — which is exactly the party you would be asking during a dispute.
 *
 * It lives beside the signing key (outside the repo) rather than in it: the
 * ledger is customer data, and the repo is checked out on machines that have no
 * business holding it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const REGISTRY_FILENAME = 'issued.jsonl';

export function registryPathFor(keyDir) {
  return join(keyDir, REGISTRY_FILENAME);
}

export function recordIssue(registryPath, entry) {
  mkdirSync(dirname(registryPath), { recursive: true });
  appendFileSync(registryPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Skips unparseable lines instead of throwing: a half-written final line after
 * an interrupted run must not make the whole history unreadable.
 */
export function readRegistry(registryPath) {
  if (!existsSync(registryPath)) return [];
  return readFileSync(registryPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null);
}
