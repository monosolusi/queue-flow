import { InvalidValueObjectException } from './errors';
import { ValueObject } from './value-object';

/**
 * Strongly-typed identifier backed by a UUID v4 string. Keeping IDs as value
 * objects (rather than raw strings) prevents accidental cross-aggregate ID
 * confusion and gives every identity a stable equality contract.
 */
export class Identifier extends ValueObject<string> {
  private constructor(value: string) {
    super(value);
  }

  public static of(value: string): Identifier {
    if (!Identifier.isValid(value)) {
      // `Identifier` is a value object, so its construction failure is reported
      // as a `InvalidValueObjectException` (a `DomainError`) — that lets
      // `DomainExceptionFilter` map a hand-crafted malformed id to 400 instead
      // of the 500 a plain `Error` would surface as. Mirrors the QUE-32
      // precedent: value-object *format* rejections throw
      // `InvalidValueObjectException`, not a bare `Error`/`InvalidArgumentException`.
      throw new InvalidValueObjectException(`invalid id '${value}'`);
    }
    return new Identifier(value);
  }

  public static generate(): Identifier {
    // RFC 4122 v4 via crypto — available in Node and modern browsers, no
    // external dependency.
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
    return new Identifier(
      `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
        .slice(6, 8)
        .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`,
    );
  }

  public static isValid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  public get value(): string {
    return this.props;
  }

  public toString(): string {
    return this.value;
  }
}