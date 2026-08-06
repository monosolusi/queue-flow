import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * Encoded password hash format produced by `ScryptPasswordHasher`:
 * `scrypt:<saltHex>:<hashHex>`. The encoding prefix lets a future hasher swap
 * in argon2/bcrypt without a migration (the verifier dispatches on the prefix).
 * Declared before the class per the TDZ rule (CLAUDE.md).
 */
const PASSWORD_HASH_RE = /^scrypt:[0-9a-f]+:[0-9a-f]+$/i;

/**
 * The stored password hash for a {@link User}. A value object wrapping the
 * encoded `scrypt:<salt>:<hash>` string. The plain password is never a domain
 * value — it crosses the `IPasswordHasher` port straight from the use case to
 * infrastructure — so this VO only ever carries the *encoded* form.
 *
 * `of()` validates the encoding shape (used when reconstituting untrusted
 * input); `reconstitute()` is the trusted DB-read path.
 */
export class PasswordHash extends ValueObject<string> {
  private constructor(value: string) {
    super(value);
  }

  public static of(value: string): PasswordHash {
    if (typeof value !== 'string' || !PASSWORD_HASH_RE.test(value)) {
      throw new InvalidValueObjectException('password hash must be `scrypt:<salt>:<hash>`');
    }
    return new PasswordHash(value);
  }

  /** Reconstitute from persisted storage (trusted DB read — no re-validation). */
  public static reconstitute(value: string): PasswordHash {
    return new PasswordHash(value);
  }

  public get value(): string {
    return this.props;
  }

  public toString(): string {
    return this.value;
  }
}