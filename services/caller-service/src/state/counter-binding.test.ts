import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCounterBinding } from './counter-binding';
import type { CounterDto } from '../api/types';

const STORAGE_KEY = 'qms.caller.counterBinding';

const counter: CounterDto = {
  counterId: 1,
  counterName: 'Loket 1',
  assignedCategories: [
    { id: 'cat-a', code: 'A', name: 'Customer Service' },
    { id: 'cat-b', code: 'B', name: 'Kasir' },
  ],
  priorityPolicy: 'FIFO_GLOBAL',
};

beforeEach(() => {
  localStorage.clear();
});

describe('useCounterBinding', () => {
  it('bind persists assignedCategories and derives ids from the counter', () => {
    const { result } = renderHook(() => useCounterBinding());
    expect(result.current.bound).toBeNull();
    act(() => result.current.bind(counter));
    expect(result.current.bound).toEqual({
      counterId: 1,
      counterName: 'Loket 1',
      assignedCategoryIds: ['cat-a', 'cat-b'],
      assignedCategories: counter.assignedCategories,
    });
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.assignedCategoryIds).toEqual(['cat-a', 'cat-b']);
    expect(raw.assignedCategories).toEqual(counter.assignedCategories);
  });

  it('restores from localStorage on mount, tolerating a missing assignedCategories field', () => {
    // A binding persisted before assignedCategories existed must still load;
    // the chooser falls back to the legacy id-only path.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ counterId: 2, counterName: 'Loket 2', assignedCategoryIds: ['cat-a'] }),
    );
    const { result } = renderHook(() => useCounterBinding());
    expect(result.current.bound).toEqual({
      counterId: 2,
      counterName: 'Loket 2',
      assignedCategoryIds: ['cat-a'],
      assignedCategories: [],
    });
  });

  it('unbind clears the binding and localStorage', () => {
    const { result } = renderHook(() => useCounterBinding());
    act(() => result.current.bind(counter));
    act(() => result.current.unbind());
    expect(result.current.bound).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});