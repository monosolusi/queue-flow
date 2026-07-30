import { Entity } from '../../shared/entity';
import { Identifier } from '../../shared/identifier';
import { InvalidValueObjectException } from '../../shared/errors';

/**
 * A queue category (e.g. `CAT-A` / `A` / "Customer Service"). Categories are
 * referenced by tickets and by counter routing rules. PRD §7.
 */
export class Category extends Entity {
  constructor(
    id: Identifier,
    public readonly code: string,
    public readonly name: string,
  ) {
    super(id);
    if (!/^[A-Z]+$/.test(code)) {
      throw new InvalidValueObjectException(
        `category code must be uppercase letters, got '${code}'`,
      );
    }
    if (!name || !name.trim()) {
      throw new InvalidValueObjectException('category name must not be empty');
    }
  }
}