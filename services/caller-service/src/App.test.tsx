import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import type { ICallerApi } from './api/caller-api';

function makeApi(brandColor = '', reject?: Error): ICallerApi {
  return {
    listCounters: () => Promise.resolve([]),
    getQueueSnapshot: () => Promise.resolve({ counterId: 0, active: [], waiting: [], waitingCount: 0 }),
    getActiveStateMachine: () => Promise.resolve({ states: [], transitions: [] }),
    callNext: () => Promise.resolve(),
    serve: () => Promise.resolve(),
    complete: () => Promise.resolve(),
    skip: () => Promise.resolve(),
    recall: () => Promise.resolve(),
    transfer: () => Promise.resolve(),
    applyTransition: () => Promise.resolve(),
    getBrandColor: reject ? () => Promise.reject(reject) : () => Promise.resolve({ brandColor }),
  };
}

function renderApp(api: ICallerApi) {
  return render(
    <MemoryRouter>
      <App api={api} />
    </MemoryRouter>,
  );
}

describe('App (caller — runtime brand color, QUE-37 AC6)', () => {
  it('applies the manager-configured brand color to --accent on mount', async () => {
    document.documentElement.style.setProperty('--accent', '#2563eb');
    renderApp(makeApi('#abcdef'));
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#abcdef'),
    );
  });

  it('keeps the static --accent default when the brand-color fetch fails (no flash)', async () => {
    document.documentElement.style.setProperty('--accent', '#2563eb');
    renderApp(makeApi('#abcdef', new Error('offline')));
    // The rejection is swallowed; the static default stays in place.
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb'),
    );
  });

  it('keeps the static --accent default when the brand color is empty', async () => {
    document.documentElement.style.setProperty('--accent', '#2563eb');
    renderApp(makeApi(''));
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb'),
    );
  });
});