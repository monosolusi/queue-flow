import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * The human-readable queue number printed on a ticket, e.g. `A-001`. Format:
 * `<CategoryCode>-<sequence>` where the category code is one uppercase letter
 * run and the sequence is zero-padded (minimum 3 digits). FR-ENG-01.
 */
export interface TicketNumberProps {
  readonly categoryCode: string;
  readonly sequence: number;
}

export class TicketNumber extends ValueObject<TicketNumberProps> {
  private constructor(props: TicketNumberProps) {
    super(props);
  }

  public static of(categoryCode: string, sequence: number): TicketNumber {
    if (!/^[A-Z]+$/.test(categoryCode)) {
      throw new InvalidValueObjectException(
        `category code must be uppercase letters, got '${categoryCode}'`,
      );
    }
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new InvalidValueObjectException(
        `sequence must be a positive integer, got '${sequence}'`,
      );
    }
    return new TicketNumber({ categoryCode, sequence });
  }

  /** Parse a formatted ticket number string such as `A-001`. */
  public static parse(formatted: string): TicketNumber {
    const match = /^([A-Z]+)-(\d+)$/.exec(formatted);
    if (!match) {
      throw new InvalidValueObjectException(
        `ticket number must match '<CODE>-<NNN>', got '${formatted}'`,
      );
    }
    return TicketNumber.of(match[1], Number.parseInt(match[2], 10));
  }

  public get categoryCode(): string {
    return this.value.categoryCode;
  }

  public get sequence(): number {
    return this.value.sequence;
  }

  public formatted(): string {
    return `${this.categoryCode}-${this.sequence.toString().padStart(3, '0')}`;
  }

  public toString(): string {
    return this.formatted();
  }
}