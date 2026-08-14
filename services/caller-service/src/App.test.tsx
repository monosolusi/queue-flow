import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import type { ICallerApi } from './api/caller-api';
import type { AuthUserDto } from './api/types';

const user: AuthUserDto = { id: 'u1', username: 'staff', role: 'caller-staff' };

function makeApi(brandColor = '', reject?: Error, me: AuthUserDto | null = user): ICallerApi {
  return {
    login: vi.fn(async () => ({ token: 'tok', user })),
    logout: vi.fn(async () => {}),
    getMe: () => Promise.resolve(me),
    listCounters: () => Promise.resolve([]),
    getQueueSnapshot: () =>
      Promise.resolve({
        counterId: 1,
        active: [{ ticketId: 'a1', ticketNumber: 'A-001', categoryId: 'cat-a', status: 'CALLING', counterId: 1 }],
        waiting: [],
        skipped: [],
        waitingCount: 0,
      }),
    getWorkflowActions: () => Promise.resolve({ byStatus: {} }),
    callNext: () => Promise.resolve(),
    serve: () => Promise.resolve(),
    complete: () => Promise.resolve(),
    skip: () => Promise.resolve(),
    recall: () => Promise.resolve(),
    reannounce: () => Promise.resolve(),
    transfer: () => Promise.resolve(),
    applyTransition: () => Promise.resolve(),
    getBrandColor: reject ? () => Promise.reject(reject) : () => Promise.resolve({ brandColor, themeMode: 'light' as const }),
  };
}

function renderApp(api: ICallerApi, initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App api={api} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

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

describe('App routing cascade (QUE-43)', () => {
  it('redirects an unauthenticated user to /login', async () => {
    renderApp(makeApi('', undefined, null), '/workspace');
    expect(await screen.findByText('Masuk Caller Panel')).toBeInTheDocument();
  });

  it('routes an authenticated + unbound user to the counter select page', async () => {
    renderApp(makeApi('', undefined, user), '/');
    expect(await screen.findByText('Pilih Loket')).toBeInTheDocument();
  });

  it('routes an authenticated + bound user to /workspace', async () => {
    localStorage.setItem(
      'qms.caller.counterBinding',
      JSON.stringify({
        counterId: 1,
        counterName: 'Loket 1',
        assignedCategoryIds: ['cat-a'],
        assignedCategories: [{ id: 'cat-a', code: 'A', name: 'Customer Service' }],
      }),
    );
    renderApp(makeApi('', undefined, user), '/workspace');
    // The workspace renders the active ticket from the snapshot.
    expect(await screen.findByText('A-001')).toBeInTheDocument();
  });
});