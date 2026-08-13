import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  TerminalNodes,
  type TerminalNodesDto,
} from '../../src/domain/store-config/value-objects/terminal-nodes';

describe('TerminalNodes (persisted Start/End marker presence + position)', () => {
  it('of(undefined) / of(null) → DEFAULT (auto/auto), toDto() deep-equals { start: "auto", end: "auto" }', () => {
    expect(TerminalNodes.of(undefined)).toBe(TerminalNodes.DEFAULT);
    expect(TerminalNodes.of(null)).toBe(TerminalNodes.DEFAULT);
    expect(TerminalNodes.DEFAULT.toDto()).toEqual({ start: 'auto', end: 'auto' });
  });

  it('of({}) → auto/auto (absent keys default to "auto")', () => {
    const tn = TerminalNodes.of({});
    expect(tn.toDto()).toEqual({ start: 'auto', end: 'auto' });
    expect(tn.start).toBe('auto');
    expect(tn.end).toBe('auto');
  });

  it('of({ start: "hidden", end: "auto" }) round-trips via toDto() and getters', () => {
    const tn = TerminalNodes.of({ start: 'hidden', end: 'auto' });
    expect(tn.start).toBe('hidden');
    expect(tn.end).toBe('auto');
    expect(tn.toDto()).toEqual({ start: 'hidden', end: 'auto' });
  });

  it('of({ start: { x: 1.5, y: 2 }, end: "auto" }) round-trips a pinned position', () => {
    const tn = TerminalNodes.of({ start: { x: 1.5, y: 2 }, end: 'auto' });
    expect(tn.start).toEqual({ x: 1.5, y: 2 });
    expect(tn.end).toBe('auto');
    expect(tn.toDto()).toEqual({ start: { x: 1.5, y: 2 }, end: 'auto' });
  });

  it('of({ start: "hidden", end: { x: -3, y: 4.25 } }) round-trips both terminals', () => {
    const tn = TerminalNodes.of({ start: 'hidden', end: { x: -3, y: 4.25 } });
    expect(tn.toDto()).toEqual({ start: 'hidden', end: { x: -3, y: 4.25 } });
  });

  it.each([
    ['a string', 'not-an-object'],
    ['a number', 5],
    ['an array', ['auto']],
    ['a boolean', true],
  ])('rejects a non-object raw (%s) with InvalidValueObjectException', (_label, raw) => {
    expect(() => TerminalNodes.of(raw)).toThrow(InvalidValueObjectException);
  });

  it('rejects a terminal value that is not "auto"/"hidden"/a plain {x,y} (a number)', () => {
    expect(() => TerminalNodes.of({ start: 5, end: 'auto' })).toThrow(InvalidValueObjectException);
  });

  it('rejects a terminal value that is an array', () => {
    expect(() => TerminalNodes.of({ start: ['auto'], end: 'auto' })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a bad terminal string (not "auto"/"hidden")', () => {
    expect(() => TerminalNodes.of({ start: 'bad', end: 'auto' })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a non-finite x in a pinned position', () => {
    expect(() => TerminalNodes.of({ start: { x: 'a', y: 0 }, end: 'auto' })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a non-finite y in a pinned position (NaN)', () => {
    expect(() => TerminalNodes.of({ start: { x: 0, y: NaN }, end: 'auto' })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a non-finite x in a pinned position (Infinity)', () => {
    expect(() => TerminalNodes.of({ start: 'auto', end: { x: Infinity, y: 0 } })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a pinned position that is missing y', () => {
    expect(() => TerminalNodes.of({ start: { x: 0 }, end: 'auto' })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('deep-copies: mutating the input after of() does not change the VO', () => {
    const input = { start: { x: 1, y: 2 }, end: 'auto' } as {
      start: { x: number; y: number };
      end: string;
    };
    const tn = TerminalNodes.of(input);
    input.start.x = 999;
    input.end = 'hidden';
    expect(tn.toDto()).toEqual({ start: { x: 1, y: 2 }, end: 'auto' });
  });

  it('toDto() returns an independent copy (mutating the DTO does not affect the VO)', () => {
    const tn = TerminalNodes.of({ start: { x: 1, y: 2 }, end: 'auto' });
    const dto = tn.toDto() as unknown as {
      start: { x: number; y: number };
      end: string;
    };
    dto.start.x = 999;
    dto.end = 'hidden';
    expect(tn.toDto()).toEqual({ start: { x: 1, y: 2 }, end: 'auto' });
  });

  it('DEFAULT is auto/auto', () => {
    expect(TerminalNodes.DEFAULT.start).toBe('auto');
    expect(TerminalNodes.DEFAULT.end).toBe('auto');
  });

  it('toString() returns JSON', () => {
    const tn = TerminalNodes.of({ start: { x: 1, y: 2 }, end: 'hidden' });
    expect(tn.toString()).toBe(JSON.stringify({ start: { x: 1, y: 2 }, end: 'hidden' }));
  });

  it('equals (inherited structural deep-equal): same map → equal, different → not', () => {
    const a = TerminalNodes.of({ start: { x: 1, y: 2 }, end: 'auto' });
    const b = TerminalNodes.of({ start: { x: 1, y: 2 }, end: 'auto' });
    const c = TerminalNodes.of({ start: { x: 1, y: 3 }, end: 'auto' });
    const d = TerminalNodes.of({ start: 'hidden', end: 'auto' });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.equals(d)).toBe(false);
  });

  it('does NOT perform state-membership validation (terminal ids are not state names)', () => {
    // The VO stays free of a StateMachine dependency (DIP). There is no
    // cross-check that "start"/"end" correspond to real states — they are
    // fixed terminal ids, NOT state names. So any valid three-state value is
    // accepted; the save use case performs NO terminal-membership validation
    // (unlike nodePositions/nodeActions whose keys ARE cross-checked).
    expect(() => TerminalNodes.of({ start: 'hidden', end: { x: 0, y: 0 } })).not.toThrow();
  });
});