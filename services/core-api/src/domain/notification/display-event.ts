import { ValueObject } from '../shared/value-object';
import { InvalidValueObjectException } from '../shared/errors';

export type DisplayEventType = 'NOW_SERVING' | 'CALL_HISTORY' | 'STANDBY';

export interface DisplayEventProps {
  readonly type: DisplayEventType;
  readonly ticketNumber: string;
  readonly counterId: number | null;
  readonly occurredAt: number;
}

/**
 * A display-sync event pushed to the TV board (FR-TV-01). Carries the
 * now-serving ticket (and the last 3-5 calls as history on the board).
 */
export class DisplayEvent extends ValueObject<DisplayEventProps> {
  private constructor(props: DisplayEventProps) {
    super(props);
  }

  public static of(props: DisplayEventProps): DisplayEvent {
    if (!props.ticketNumber && props.type !== 'STANDBY') {
      throw new InvalidValueObjectException('display event requires a ticket number');
    }
    return new DisplayEvent(props);
  }

  public get type(): DisplayEventType {
    return this.value.type;
  }

  public get ticketNumber(): string {
    return this.value.ticketNumber;
  }

  public get counterId(): number | null {
    return this.value.counterId;
  }

  public get occurredAt(): number {
    return this.value.occurredAt;
  }
}