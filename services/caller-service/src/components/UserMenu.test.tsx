import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ICallerApi } from '../api/caller-api';
import type { AuthUserDto } from '../api/types';
import { AuthProvider } from '../auth/useAuth';
import { writeToken } from '../auth/token-store';
import { UserMenu } from './UserMenu';

const user: AuthUserDto = { id: 'u1', username: 'staff1', role: 'caller-staff' };

function makeApi(logoutImpl: ICallerApi['logout'] = vi.fn(async () => {})): ICallerApi {
  return {
    login: vi.fn(async () => ({ token: 'tok', user })),
    logout: logoutImpl,
    getMe: vi.fn(async () => user),
    listCounters: vi.fn(async () => []),
    getQueueSnapshot: vi.fn(async () => ({ counterId: 0, active: [], waiting: [], waitingCount: 0 })),
    getActiveStateMachine: vi.fn(async () => ({ states: [], transitions: [] })),
    getBrandColor: vi.fn(async () => ({ brandColor: '' })),
    callNext: vi.fn(async () => {}),
    serve: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    skip: vi.fn(async () => {}),
    recall: vi.fn(async () => {}),
    reannounce: vi.fn(async () => {}),
    transfer: vi.fn(async () => {}),
    applyTransition: vi.fn(async () => {}),
  };
}

function renderMenu(api: ICallerApi) {
  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <AuthProvider api={api}>
        <Routes>
          <Route
            path="/workspace"
            element={
              <div>
                <UserMenu />
              </div>
            }
          />
          <Route path="/login" element={<div>Login Page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  writeToken('tok');
  localStorage.setItem(
    'qms.caller.counterBinding',
    JSON.stringify({ counterId: 1, counterName: 'Loket 1', assignedCategoryIds: [] }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UserMenu (QUE-43)', () => {
  it('shows the signed-in username', async () => {
    renderMenu(makeApi());
    expect(await screen.findByText('staff1')).toBeInTheDocument();
  });

  it('renders nothing when there is no authenticated user', async () => {
    const api = makeApi();
    api.getMe = vi.fn(async () => null);
    renderMenu(api);
    // No toggle button while unauthenticated.
    expect(screen.queryByRole('button', { name: /staff1/i })).not.toBeInTheDocument();
  });

  it('logout clears the token, calls the server logout, and navigates to /login', async () => {
    const logoutSpy = vi.fn(async () => {});
    renderMenu(makeApi(logoutSpy));
    // Find the toggle outside act (findByRole polls; awaiting inside act deadlocks).
    const toggle = await screen.findByRole('button', { name: /staff1/i });
    await act(async () => {
      await userEvent.click(toggle);
    });

    const keluar = await screen.findByRole('menuitem', { name: 'Keluar' });
    await act(async () => {
      await userEvent.click(keluar);
    });

    // Navigated to the login route.
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
    // Server logout was called.
    expect(logoutSpy).toHaveBeenCalledTimes(1);
    // Token cleared.
    expect(localStorage.getItem('qms.caller.token')).toBeNull();
    // Device-local counter binding preserved across logout.
    expect(localStorage.getItem('qms.caller.counterBinding')).not.toBeNull();
  });

  it('closes the menu on Escape', async () => {
    renderMenu(makeApi());
    const toggle = await screen.findByRole('button', { name: /staff1/i });
    await act(async () => {
      await userEvent.click(toggle);
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await act(async () => {
      // jsdom: dispatch a real Escape so the document listener fires.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the menu on outside-click', async () => {
    renderMenu(makeApi());
    const toggle = await screen.findByRole('button', { name: /staff1/i });
    await act(async () => {
      await userEvent.click(toggle);
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await act(async () => {
      // jsdom has no PointerEvent constructor; a MouseEvent carries the target
      // + bubbles the document listener reads.
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});