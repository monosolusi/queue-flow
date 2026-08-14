import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { InvalidCredentialsError } from '../api/caller-api';
import type { ICallerApi } from '../api/caller-api';
import type { AuthUserDto } from '../api/types';
import { AuthProvider } from '../auth/useAuth';
import { LoginPage } from './LoginPage';

const user: AuthUserDto = { id: 'u1', username: 'staff', role: 'caller-staff' };

function makeApi(loginImpl: ICallerApi['login']): ICallerApi {
  return {
    login: loginImpl,
    logout: vi.fn(async () => {}),
    getMe: vi.fn(async () => null),
    listCounters: vi.fn(async () => []),
    getQueueSnapshot: vi.fn(async () => ({
      counterId: 0,
      active: [],
      waiting: [],
      skipped: [],
      waitingCount: 0,
    })),
    getWorkflowActions: vi.fn(async () => ({ byStatus: {} })),
    getBrandColor: vi.fn(async () => ({ brandColor: '', themeMode: 'light' as const })),
    callNext: vi.fn(async () => {}),
    reannounce: vi.fn(async () => {}),
    transfer: vi.fn(async () => {}),
    applyTransition: vi.fn(async () => {}),
  };
}

function renderLogin(api: ICallerApi) {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider api={api}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>Home</div>} />
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

describe('LoginPage (QUE-43)', () => {
  it('stores the token and navigates to / on success', async () => {
    const api = makeApi(vi.fn(async () => ({ token: 'server-tok', user })));
    renderLogin(api);

    await userEvent.type(screen.getByLabelText('Username'), 'staff');
    await userEvent.type(screen.getByLabelText('Kata Sandi'), 'pw');
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    });

    // Token persisted + navigated to the home route.
    expect(await screen.findByText('Home')).toBeInTheDocument();
    expect(localStorage.getItem('qms.caller.token')).toBe('server-tok');
  });

  it('shows "Username atau kata sandi salah" on 401 (invalid credentials)', async () => {
    const api = makeApi(vi.fn(async () => Promise.reject(new InvalidCredentialsError())));
    renderLogin(api);

    await userEvent.type(screen.getByLabelText('Username'), 'staff');
    await userEvent.type(screen.getByLabelText('Kata Sandi'), 'bad');
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    });

    expect(await screen.findByText('Username atau kata sandi salah')).toBeInTheDocument();
    // Did not navigate away, no token stored.
    expect(screen.getByRole('button', { name: 'Masuk' })).toBeInTheDocument();
    expect(localStorage.getItem('qms.caller.token')).toBeNull();
  });

  it('shows a connection-failure message on a generic error', async () => {
    const api = makeApi(vi.fn(async () => Promise.reject(new Error('server down'))));
    renderLogin(api);

    await userEvent.type(screen.getByLabelText('Username'), 'staff');
    await userEvent.type(screen.getByLabelText('Kata Sandi'), 'pw');
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    });

    expect(await screen.findByText(/Gagal masuk/i)).toBeInTheDocument();
  });

  it('associates the error with an alert role for assistive tech', async () => {
    const api = makeApi(vi.fn(async () => Promise.reject(new InvalidCredentialsError())));
    renderLogin(api);

    await userEvent.type(screen.getByLabelText('Username'), 'staff');
    await userEvent.type(screen.getByLabelText('Kata Sandi'), 'bad');
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Username atau kata sandi salah');
  });
});