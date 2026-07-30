import { useCallback, useEffect, useState } from 'react';
import type { CounterDto } from '../api/types';

/**
 * The counter a staff member is bound to for this session. Persisted in
 * `localStorage` so the binding survives reloads on the device (FR-CLR-01 —
 * "context counter dipertahankan selama sesi kerja"). Only the fields the
 * workspace needs offline are stored; no auth backend (the panel is LAN-only,
 * NFR-SEC-01).
 */
export interface BoundCounter {
  readonly counterId: number;
  readonly counterName: string;
  /** Assigned-category ids, used to filter the realtime queue to this counter. */
  readonly assignedCategoryIds: readonly string[];
}

const STORAGE_KEY = 'qms.caller.counterBinding';

function read(): BoundCounter | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<BoundCounter>;
    if (typeof parsed.counterId !== 'number' || typeof parsed.counterName !== 'string') {
      return null;
    }
    return {
      counterId: parsed.counterId,
      counterName: parsed.counterName,
      assignedCategoryIds: Array.isArray(parsed.assignedCategoryIds) ? parsed.assignedCategoryIds : [],
    };
  } catch {
    return null;
  }
}

function write(counter: BoundCounter | null): void {
  try {
    if (counter) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(counter));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable (private mode); the binding just won't
    // persist — the in-memory state still drives the UI for this session.
  }
}

export interface CounterBinding {
  /** The bound counter, or null when none selected yet. */
  readonly bound: BoundCounter | null;
  /** Persist + set the binding from a chosen counter. */
  readonly bind: (counter: CounterDto) => void;
  /** Clear the binding (the "Ganti Counter" action). */
  readonly unbind: () => void;
}

/**
 * Hook backing the counter binding. Also re-syncs when another tab on the same
 * device updates the binding (storage event).
 */
export function useCounterBinding(): CounterBinding {
  const [bound, setBound] = useState<BoundCounter | null>(() => read());

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        setBound(read());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const bind = useCallback((counter: CounterDto) => {
    const next: BoundCounter = {
      counterId: counter.counterId,
      counterName: counter.counterName,
      assignedCategoryIds: counter.assignedCategories.map((c) => c.id),
    };
    write(next);
    setBound(next);
  }, []);

  const unbind = useCallback(() => {
    write(null);
    setBound(null);
  }, []);

  return { bound, bind, unbind };
}