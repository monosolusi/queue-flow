import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * Username validation pattern: 3–32 chars of letters, digits, underscore, dot,
 * or hyphen. Declared **before** the class so any future `static DEFAULT`
 * initializer referencing it evaluates against an initialized binding (TDZ —
 * see CLAUDE.md "Declare module-level const's BEFORE a domain VO class").
 */
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

/**
 * A login username (Identity bounded context). A self-validating value object:
 * construction failure throws {@link InvalidValueObjectException} (a
 * `DomainError` → 400) so a malformed username is rejected at the source with
 * the correct status, never a bare `Error` → 500. Source-owns-construction-
 * failure rule (QUE-31 precedent).
 */
export class Username extends ValueObject<string> {
  private constructor(value: string) {
    super(value);
  }

  public static of(value: string): Username {
    if (typeof value !== 'string' || !USERNAME_RE.test(value)) {
      throw new InvalidValueObjectException(
        `username must be 3–32 chars of [a-zA-Z0-9_.-], got '${value}'`,
      );
    }
    return new Username(value);
  }

  /** Reconstitute from persisted storage (no validation — trusted DB read). */
  public static reconstitute(value: string): Username {
    return new Username(value);
  }

  public get value(): string {
    return this.props;
  }

  public toString(): string {
    return this.value;
  }
}