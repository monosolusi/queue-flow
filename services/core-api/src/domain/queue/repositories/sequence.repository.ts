import type { TicketNumber } from '../value-objects/ticket-number';

/**
 * Repository abstraction for the per-category, per-day ticket sequence.
 * FR-ENG-01 (generation) and FR-ENG-05 (daily reset). Implementations MUST make
 * `nextTicketNumber` atomic so a crash mid-increment leaves the sequence
 * consistent (NFR-REL-02) — no duplicate numbers, no gaps.
 */
export interface ISequenceRepository {
  /** Atomically reserves and returns the next ticket number for the day. */
  nextTicketNumber(categoryId: string, categoryCode: string, date: string): Promise<TicketNumber>;
  /** Returns the sequence counter's current value without advancing it. */
  currentSequence(categoryId: string, date: string): Promise<number>;
  /** Resets the sequence for the given date back to `resetTo` (FR-ENG-05). */
  resetDaily(date: string, resetTo?: number): Promise<void>;
}