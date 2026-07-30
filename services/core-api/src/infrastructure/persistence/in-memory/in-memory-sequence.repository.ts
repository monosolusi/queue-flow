import { ISequenceRepository, TicketNumber } from '../../../domain/queue';

/**
 * In-memory implementation of {@link ISequenceRepository}. The atomicity that a
 * Postgres implementation gets from a transaction/row-lock is approximated here
 * by a synchronous in-process increment — sufficient for tests, not for
 * production power-loss resilience (NFR-REL-02).
 */
export class InMemorySequenceRepository implements ISequenceRepository {
  private readonly sequences = new Map<string, number>();

  private key(categoryId: string, date: string): string {
    return `${categoryId}|${date}`;
  }

  async nextTicketNumber(categoryId: string, categoryCode: string, date: string): Promise<TicketNumber> {
    const k = this.key(categoryId, date);
    const next = (this.sequences.get(k) ?? 0) + 1;
    this.sequences.set(k, next);
    return TicketNumber.of(categoryCode, next);
  }

  async currentSequence(categoryId: string, date: string): Promise<number> {
    return this.sequences.get(this.key(categoryId, date)) ?? 0;
  }

  async resetDaily(date: string, resetTo = 1): Promise<void> {
    for (const key of [...this.sequences.keys()]) {
      if (key.endsWith(`|${date}`)) {
        this.sequences.set(key, resetTo - 1);
      }
    }
  }

  /** Test/dev-only: drops all sequence counters. Not on the port interface. */
  clear(): void {
    this.sequences.clear();
  }
}