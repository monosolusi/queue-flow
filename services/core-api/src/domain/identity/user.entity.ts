import { Entity } from '../shared/entity';
import { Identifier } from '../shared/identifier';
import { PasswordHash } from './value-objects/password-hash';
import { Role } from './value-objects/role';
import { Username } from './value-objects/username';

/** Branded id so a user id is never confused with a ticket/category id. */
export type UserId = Identifier & { readonly __brand: 'UserId' };

export function userIdOf(value: string): UserId {
  return Identifier.of(value) as UserId;
}

export function userIdGenerate(): UserId {
  return Identifier.generate() as UserId;
}

export interface UserProps {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A local user account in the Identity bounded context (QUE-43). Identified by
 * a UUID, defined by its username (unique). Carries a {@link PasswordHash}
 * (the encoded `scrypt:…` string — the plain password is never stored) and a
 * {@link Role} for authorization.
 *
 * Not an aggregate root: users have no domain events and no invariant beyond
 * their own fields, so `Entity` (not `AggregateRoot`) is the right base.
 */
export class User extends Entity<Identifier> {
  private _username: Username;
  private _passwordHash: PasswordHash;
  private _role: Role;
  private _createdAt: number;
  private _updatedAt: number;

  private constructor(
    id: Identifier,
    username: Username,
    passwordHash: PasswordHash,
    role: Role,
    createdAt: number,
    updatedAt: number,
  ) {
    super(id);
    this._username = username;
    this._passwordHash = passwordHash;
    this._role = role;
    this._createdAt = createdAt;
    this._updatedAt = updatedAt;
  }

  /**
   * Create a new user (mints id + timestamps from the injected clock). Use cases
   * call this after hashing the plain password and resolving a unique username.
   */
  public static create(params: {
    username: Username;
    passwordHash: PasswordHash;
    role: Role;
    clock: () => number;
    id?: Identifier;
  }): User {
    const now = params.clock();
    return new User(
      params.id ?? Identifier.generate(),
      params.username,
      params.passwordHash,
      params.role,
      now,
      now,
    );
  }

  /** Reconstitute from persisted storage (trusted DB read — no re-validation). */
  public static reconstitute(props: UserProps): User {
    return new User(
      Identifier.of(props.id),
      Username.reconstitute(props.username),
      PasswordHash.reconstitute(props.passwordHash),
      props.role,
      props.createdAt,
      props.updatedAt,
    );
  }

  public get id(): Identifier {
    return this._id;
  }
  public get username(): Username {
    return this._username;
  }
  public get passwordHash(): PasswordHash {
    return this._passwordHash;
  }
  public get role(): Role {
    return this._role;
  }
  public get createdAt(): number {
    return this._createdAt;
  }
  public get updatedAt(): number {
    return this._updatedAt;
  }

  /** Replace the password hash (admin reset / password change). */
  public changePassword(hash: PasswordHash, clock: () => number): void {
    this._passwordHash = hash;
    this._updatedAt = clock();
  }

  /** Snapshot for persistence / audit. */
  public toSnapshot(): UserProps {
    return {
      id: this._id.value,
      username: this._username.value,
      passwordHash: this._passwordHash.value,
      role: this._role,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}