import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, readToken, UNAUTHORIZED_EVENT, writeToken } from './token-store';

/**
 * The token store (QUE-43) is a thin localStorage wrapper keyed `qms.admin.token`
 * with try/catch around every op so private-mode browsers degrade gracefully.
 * jsdom provides a working localStorage; these specs exercise the happy path
 * plus the private-mode (storage-throws) tolerance, which is the load-bearing
 * invariant (mirrors caller-service's counter-binding pattern).
 */
describe('token-store (QUE-43)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('readToken returns null when nothing is stored', () => {
    expect(readToken()).toBeNull();
  });

  it('writeToken persists and readToken round-trips the token', () => {
    writeToken('abc123');
    expect(readToken()).toBe('abc123');
  });

  it('writeToken overwrites a prior token', () => {
    writeToken('first');
    writeToken('second');
    expect(readToken()).toBe('second');
  });

  it('clearToken removes the stored token', () => {
    writeToken('abc123');
    clearToken();
    expect(readToken()).toBeNull();
  });

  it('exposes the unauthorized event constant', () => {
    expect(UNAUTHORIZED_EVENT).toBe('qms:unauthorized');
  });

  describe('private-mode tolerance (storage throws)', () => {
    // Capture the real descriptor once so the outer `localStorage.clear()`
    // beforeEach does not trip over the thrower on the next test in this block.
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    let thrower: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      thrower = vi.fn(() => {
        throw new Error('SecurityError: localStorage unavailable');
      });
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: { getItem: thrower, setItem: thrower, removeItem: thrower, clear: thrower },
      });
    });
    afterEach(() => {
      if (original) Object.defineProperty(window, 'localStorage', original);
    });

    it('readToken returns null when storage throws (does not crash)', () => {
      expect(readToken()).toBeNull();
      expect(thrower).toHaveBeenCalled();
    });

    it('writeToken swallows the throw (does not crash)', () => {
      expect(() => writeToken('abc123')).not.toThrow();
    });

    it('clearToken swallows the throw (does not crash)', () => {
      expect(() => clearToken()).not.toThrow();
    });
  });
});