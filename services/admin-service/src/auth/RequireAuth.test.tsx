import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth-context';
import { RequireAuth } from './RequireAuth';
import { writeToken, clearToken } from './token-store';
import type { IAuthApi } from '../api/admin-api';
import type { AuthUserDto } from '../api/types';

const ADMIN: AuthUserDto = { id: 'u-1', username: 'manajer', role: 'admin' };

function makeAuthApi(me: Promise<AuthUserDto> | Error = Promise.resolve(ADMIN)): IAuthApi {
  return {
    login: vi.fn(() => Promise.resolve({ token: 't', user: ADMIN })),
    logout: vi.fn(() => Promise.resolve()),
    getMe: vi.fn(() => (me instanceof Error ? Promise.reject(me) : me)),
    setupInitialAdmin: vi.fn(() =>
      Promise.resolve({ id: 'u-1', username: 'manajer', role: 'admin' as const, createdAt: 0 }),
    ),
  };
}

/** Renders RequireAuth inside a router + AuthProvider so `<Navigate to="/login">` resolves. */
function renderGuard(api: IAuthApi) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider api={api}>
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <div>Admin Panel Content</div>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<div>Login Page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RequireAuth (QUE-43)', () => {
  beforeEach(() => {
    clearToken();
  });
  afterEach(() => {
    clearToken();
  });

  it('redirects to /login when there is no token (unauthenticated)', async () => {
    // No token → loading is false from the start and the user stays null.
    renderGuard(makeAuthApi());
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
    expect(screen.queryByText('Admin Panel Content')).not.toBeInTheDocument();
  });

  it('renders children once the /me probe resolves an authenticated user', async () => {
    writeToken('abc123');
    renderGuard(makeAuthApi());
    expect(await screen.findByText('Admin Panel Content')).toBeInTheDocument();
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument();
  });

  it('shows the loading state while the /me probe is in flight (no premature redirect)', async () => {
    writeToken('abc123');
    // A /me call that never resolves keeps `loading` true so a deep-linking
    // manager is not bounced to /login before the probe completes.
    const pending = new Promise<AuthUserDto>(() => {});
    renderGuard(makeAuthApi(pending));
    expect(screen.getByText('Memuat sesi…')).toBeInTheDocument();
    expect(screen.queryByText('Admin Panel Content')).not.toBeInTheDocument();
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument();
  });

  it('redirects to /login when the stored token is rejected (401 from /me)', async () => {
    writeToken('stale');
    renderGuard(makeAuthApi(new Error('GET /auth/me -> 401')));
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
    expect(screen.queryByText('Admin Panel Content')).not.toBeInTheDocument();
  });
});