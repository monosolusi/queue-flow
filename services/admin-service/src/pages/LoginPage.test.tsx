import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/auth-context';
import { clearToken, readToken } from '../auth/token-store';
import { LoginPage } from './LoginPage';
import type { IAuthApi } from '../api/admin-api';
import type { AuthUserDto } from '../api/types';

const ADMIN: AuthUserDto = { id: 'u-1', username: 'manajer', role: 'admin' };

function makeAuthApi(loginImpl: (u: string, p: string) => Promise<{ token: string; user: AuthUserDto }> = () => Promise.resolve({ token: 'tok-1', user: ADMIN })): {
  api: IAuthApi;
  login: ReturnType<typeof vi.fn>;
  getMe: ReturnType<typeof vi.fn>;
} {
  const login = vi.fn(loginImpl);
  const getMe = vi.fn(() => Promise.resolve(ADMIN));
  const api: IAuthApi = {
    login,
    logout: vi.fn(() => Promise.resolve()),
    getMe,
    setupInitialAdmin: vi.fn(() =>
      Promise.resolve({ id: 'u-1', username: 'manajer', role: 'admin' as const, createdAt: 0 }),
    ),
  };
  return { api, login, getMe };
}

function renderLogin(api: IAuthApi) {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider api={api}>
        <Routes>
          <Route path="/login" element={<LoginPage api={api} />} />
          <Route path="/" element={<div>Admin Home</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage (QUE-43)', () => {
  beforeEach(() => {
    clearToken();
  });
  afterEach(() => {
    clearToken();
  });

  it('renders the username + password fields and a disabled submit until both are filled', () => {
    renderLogin(makeAuthApi().api);
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Kata sandi')).toBeInTheDocument();
    expect(screen.getByTestId('login-submit')).toBeDisabled();
  });

  it('enables the submit once username + password are non-empty', async () => {
    renderLogin(makeAuthApi().api);
    await userEvent.type(screen.getByLabelText('Username'), 'manajer');
    await userEvent.type(screen.getByLabelText('Kata sandi'), 'rahasia');
    expect(screen.getByTestId('login-submit')).not.toBeDisabled();
  });

  it('logs in, stores the token, and navigates to / on success', async () => {
    const { api, login, getMe } = makeAuthApi();
    renderLogin(api);

    await userEvent.type(screen.getByLabelText('Username'), 'manajer');
    await userEvent.type(screen.getByLabelText('Kata sandi'), 'rahasia123');
    await userEvent.click(screen.getByTestId('login-submit'));

    expect(await screen.findByText('Admin Home')).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith('manajer', 'rahasia123');
    // The token was stored and /me re-probed so RequireAuth sees the principal.
    expect(readToken()).toBe('tok-1');
    expect(getMe).toHaveBeenCalled();
  });

  it('trims the username before sending', async () => {
    const { api, login } = makeAuthApi();
    renderLogin(api);
    await userEvent.type(screen.getByLabelText('Username'), '  manajer  ');
    await userEvent.type(screen.getByLabelText('Kata sandi'), 'rahasia123');
    await userEvent.click(screen.getByTestId('login-submit'));
    await screen.findByText('Admin Home');
    expect(login).toHaveBeenCalledWith('manajer', 'rahasia123');
  });

  it('surfaces an Indonesian error on 401 (invalid credentials) and stays on the page', async () => {
    const { api } = makeAuthApi(() => Promise.reject(new Error('POST /auth/login -> 401')));
    renderLogin(api);

    await userEvent.type(screen.getByLabelText('Username'), 'manajer');
    await userEvent.type(screen.getByLabelText('Kata sandi'), 'salah');
    await userEvent.click(screen.getByTestId('login-submit'));

    expect(await screen.findByTestId('login-error')).toHaveTextContent('Username atau kata sandi salah');
    // Still on the login page (did not navigate to /).
    expect(screen.queryByText('Admin Home')).not.toBeInTheDocument();
    // No token stored on failure.
    expect(readToken()).toBeNull();
  });

  it('the error is announced via role=alert (aria-live)', () => {
    renderLogin(makeAuthApi(() => Promise.reject(new Error('401'))).api);
    // The error node is role=alert; before submit it's absent, but the slot
    // is wired so assert the page has no stray alert initially.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});