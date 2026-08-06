import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ICallerApi } from '../api/caller-api';
import type { AuthUserDto } from '../api/types';
import { writeToken } from './token-store';
import { AuthProvider, useAuth } from './useAuth';
import { RequireAuth } from './RequireAuth';

const user: AuthUserDto = { id: 'u1', username: 'staff', role: 'caller-staff' };

function makeApi(opts: { me?: AuthUserDto | null; rejectMe?: Error } = {}): ICallerApi {
  return {
    login: vi.fn(async () => ({ token: 'tok', user })),
    logout: vi.fn(async () => {}),
    getMe: opts.rejectMe
      ? vi.fn(() => Promise.reject(opts.rejectMe!))
      : vi.fn(() => Promise.resolve(opts.me ?? null)),
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

function renderGuard(api: ICallerApi) {
  return render(
    <MemoryRouter initialEntries={['/protected']}>
      <AuthProvider api={api}>
        <Routes>
          <Route
            path="/protected"
            element={
              <RequireAuth>
                <div>Protected Content</div>
              </RequireAuth>
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RequireAuth (QUE-43)', () => {
  it('redirects to /login when no token resolves a user', async () => {
    renderGuard(makeApi({ me: null }));
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
  });

  it('renders children when the token resolves a user', async () => {
    renderGuard(makeApi({ me: user }));
    expect(await screen.findByText('Protected Content')).toBeInTheDocument();
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument();
  });

  it('shows a loading state while the user is being resolved', () => {
    renderGuard(makeApi({ me: user }));
    // Before getMe resolves, the guard renders the loading message.
    expect(screen.getByText('Memuat sesi…')).toBeInTheDocument();
  });

  it('redirects to /login when getMe rejects (defensive — treat as unauthenticated)', async () => {
    renderGuard(makeApi({ rejectMe: new Error('server down') }));
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
  });
});

/** A tiny harness that exposes the context value via a consumer so we can
 *  drive login/logout transitions directly. */
function AuthProbe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="user">{auth.user?.username ?? 'none'}</span>
      <span data-testid="loading">{auth.loading ? 'loading' : 'ready'}</span>
      <button type="button" onClick={() => void auth.login('staff', 'pw')}>
        do-login
      </button>
      <button type="button" onClick={() => void auth.logout()}>
        do-logout
      </button>
    </div>
  );
}

function renderProbe(api: ICallerApi) {
  return render(
    <MemoryRouter>
      <AuthProvider api={api}>
        <AuthProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('useAuth login/logout transitions (QUE-43)', () => {
  it('login persists the token and resolves the user in one transition', async () => {
    const api = makeApi({ me: null });
    renderProbe(api);
    // getMe resolves null → loading false ("ready"), user "none".
    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.getByTestId('user')).toHaveTextContent('none');

    await act(async () => {
      screen.getByText('do-login').click();
    });
    expect(screen.getByTestId('user')).toHaveTextContent('staff');
    expect(localStorage.getItem('qms.caller.token')).toBe('tok');
  });

  it('logout clears the token (NOT the counter binding) and nulls the user', async () => {
    localStorage.setItem(
      'qms.caller.counterBinding',
      JSON.stringify({ counterId: 1, counterName: 'Loket 1', assignedCategoryIds: [] }),
    );
    writeToken('tok');
    const api = makeApi({ me: user });
    renderProbe(api);
    expect(await screen.findByTestId('user')).toHaveTextContent('staff');

    await act(async () => {
      screen.getByText('do-logout').click();
    });
    // Wait for the async logout to settle.
    await screen.findByTestId('user');
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(localStorage.getItem('qms.caller.token')).toBeNull();
    // Counter binding preserved across logout (device-local).
    expect(localStorage.getItem('qms.caller.counterBinding')).not.toBeNull();
  });

  it('login surfaces InvalidCredentialsError so the form can show it', async () => {
    const { InvalidCredentialsError } = await import('../api/caller-api');
    const api = makeApi();
    api.login = vi.fn(async () => Promise.reject(new InvalidCredentialsError()));
    let caught: unknown = null;
    function Probe() {
      const auth = useAuth();
      return (
        <button
          type="button"
          onClick={async () => {
            try {
              await auth.login('staff', 'bad');
            } catch (e) {
              caught = e;
            }
          }}
        >
          do-login
        </button>
      );
    }
    render(
      <MemoryRouter>
        <AuthProvider api={api}>
          <Probe />
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      screen.getByText('do-login').click();
    });
    await act(async () => {
      // flush the async handler
    });
    expect(caught).toBeInstanceOf(InvalidCredentialsError);
  });
});