import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, readToken, writeToken } from './token-store';

const TOKEN_KEY = 'qms.caller.token';
const BINDING_KEY = 'qms.caller.counterBinding';

beforeEach(() => {
  localStorage.clear();
});

describe('token-store (QUE-43)', () => {
  it('write/read round-trips the token', () => {
    expect(readToken()).toBeNull();
    writeToken('abc123');
    expect(readToken()).toBe('abc123');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('abc123');
  });

  it('clearToken removes the token', () => {
    writeToken('abc123');
    clearToken();
    expect(readToken()).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('clearToken does NOT touch the device-local counter binding', () => {
    writeToken('abc123');
    localStorage.setItem(
      BINDING_KEY,
      JSON.stringify({ counterId: 1, counterName: 'Loket 1', assignedCategoryIds: [] }),
    );
    clearToken();
    expect(readToken()).toBeNull();
    expect(localStorage.getItem(BINDING_KEY)).not.toBeNull();
  });

  it('readToken is private-mode tolerant when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('quota / private mode');
    });
    expect(readToken()).toBeNull();
    vi.restoreAllMocks();
  });

  it('writeToken is private-mode tolerant when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota / private mode');
    });
    expect(() => writeToken('abc123')).not.toThrow();
    vi.restoreAllMocks();
  });

  it('clearToken is private-mode tolerant when localStorage.removeItem throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('quota / private mode');
    });
    expect(() => clearToken()).not.toThrow();
    vi.restoreAllMocks();
  });
});