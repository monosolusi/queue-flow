import { ValueObject } from '../shared/value-object';
import { InvalidValueObjectException } from '../shared/errors';

export interface AudioQueueItemProps {
  readonly ticketNumber: string;
  readonly counterId: number;
  readonly categoryCode: string;
  /** Ordered audio fragments to play sequentially, e.g. ["bell","A","0","0","5"]. */
  readonly fragments: readonly string[];
}

/**
 * A single announcement queued for sequential playback on the TV display
 * (FR-TV-02). Value object — immutable once enqueued.
 */
export class AudioQueueItem extends ValueObject<AudioQueueItemProps> {
  private constructor(props: AudioQueueItemProps) {
    super(props);
  }

  public static of(props: AudioQueueItemProps): AudioQueueItem {
    if (!props.ticketNumber) {
      throw new InvalidValueObjectException('ticket number is required');
    }
    if (!Number.isInteger(props.counterId) || props.counterId < 1) {
      throw new InvalidValueObjectException(`invalid counter id '${props.counterId}'`);
    }
    if (!props.fragments.length) {
      throw new InvalidValueObjectException('audio queue item needs at least one fragment');
    }
    return new AudioQueueItem(props);
  }

  public get ticketNumber(): string {
    return this.value.ticketNumber;
  }

  public get counterId(): number {
    return this.value.counterId;
  }

  public get categoryCode(): string {
    return this.value.categoryCode;
  }

  public get fragments(): readonly string[] {
    return this.value.fragments;
  }
}