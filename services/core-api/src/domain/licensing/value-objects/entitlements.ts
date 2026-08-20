import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

export interface EntitlementsProps {
  /** `null` means uncapped. */
  readonly maxCounters: number | null;
  readonly maxCategories: number | null;
  readonly features: readonly string[];
}

export interface EntitlementsDto {
  maxCounters: number | null;
  maxCategories: number | null;
  features: string[];
}

/**
 * What a licence permits, beyond simply running.
 *
 * `null` means uncapped rather than zero — an absent cap in an older licence
 * must widen to "no limit", never narrow to "nothing allowed", or a licence
 * issued before a cap existed would brick the store the day the cap shipped.
 *
 * Caps are enforced where the resource is CREATED (saving counter routings /
 * categories), not read back, so an over-cap store that predates its licence
 * keeps serving and is merely unable to add more.
 */
export class Entitlements extends ValueObject<EntitlementsProps> {
  private constructor(props: EntitlementsProps) {
    super(props);
  }

  public static of(raw: unknown): Entitlements {
    if (raw === undefined || raw === null) {
      return Entitlements.UNLIMITED;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `license entitlements must be a plain object, got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;
    return new Entitlements({
      maxCounters: readCap(incoming.maxCounters, 'maxCounters'),
      maxCategories: readCap(incoming.maxCategories, 'maxCategories'),
      features: readFeatures(incoming.features),
    });
  }

  public static readonly UNLIMITED: Entitlements = new Entitlements({
    maxCounters: null,
    maxCategories: null,
    features: [],
  });

  public get maxCounters(): number | null {
    return this.props.maxCounters;
  }

  public get maxCategories(): number | null {
    return this.props.maxCategories;
  }

  public has(feature: string): boolean {
    return this.props.features.includes(feature);
  }

  /** @returns true when `count` exceeds the cap (uncapped never exceeds). */
  public exceedsCounters(count: number): boolean {
    return this.props.maxCounters !== null && count > this.props.maxCounters;
  }

  public exceedsCategories(count: number): boolean {
    return this.props.maxCategories !== null && count > this.props.maxCategories;
  }

  public toDto(): EntitlementsDto {
    return {
      maxCounters: this.props.maxCounters,
      maxCategories: this.props.maxCategories,
      features: [...this.props.features],
    };
  }
}

function readCap(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw;
  throw new InvalidValueObjectException(
    `license entitlements.${field} must be a positive integer or null, got '${String(raw)}'`,
  );
}

function readFeatures(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((f) => typeof f !== 'string')) {
    throw new InvalidValueObjectException(
      `license entitlements.features must be an array of strings, got '${String(raw)}'`,
    );
  }
  return [...(raw as string[])];
}
