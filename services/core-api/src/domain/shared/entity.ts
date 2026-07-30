import type { Identifier } from './identifier';

/**
 * Base for entities — objects defined by their identity rather than their
 * attribute values. Equality is by identifier, not by content.
 */
export abstract class Entity<TId extends Identifier = Identifier> {
  protected readonly _id: TId;

  constructor(id: TId) {
    this._id = id;
  }

  public get id(): TId {
    return this._id;
  }

  public equals(other: Entity<TId>): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    return this._id.equals(other._id);
  }
}