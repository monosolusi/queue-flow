import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/auth-context';
import { ToastProvider } from '../toast/toast-context';
import { clearToken, writeToken } from '../auth/token-store';
import { UsersPage } from './UsersPage';
import type { IAuthApi, IUsersApi } from '../api/admin-api';
import type { AuthUserDto, UserDto, UserRole } from '../api/types';

const ADMIN: AuthUserDto = { id: 'u-1', username: 'manajer', role: 'admin' };
const STAFF_PRINCIPAL: AuthUserDto = { id: 'u-9', username: 'loket1', role: 'caller-staff' };

function user(id: string, username: string, role: UserRole, createdAt = 1000): UserDto {
  return { id, username, role, createdAt };
}

/** Builds the IAuthApi used by AuthProvider to resolve the principal (`/me`). */
function makeAuthApi(me: AuthUserDto): IAuthApi {
  return {
    login: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
    getMe: vi.fn(() => Promise.resolve(me)),
    setupInitialAdmin: vi.fn(),
  };
}

/** Builds a fake IUsersApi with controllable list/create/delete spies. */
function makeUsersApi(
  list: readonly UserDto[] = [user('u-1', 'manajer', 'admin'), user('u-2', 'loket1', 'caller-staff')],
): { api: IUsersApi; listUsers: ReturnType<typeof vi.fn>; createUser: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> } {
  const listUsers = vi.fn(() => Promise.resolve(list));
  const createUser = vi.fn((input: { username: string; password: string; role: UserRole }) =>
    Promise.resolve(user('u-new', input.username, input.role, 2000)),
  );
  const deleteUser = vi.fn(() => Promise.resolve());
  return { api: { listUsers, createUser, deleteUser }, listUsers, createUser, deleteUser };
}

/** Wrapped in a real ToastProvider — create/delete SUCCESS is announced there
 *  (failures stay inline in the modal, next to the field to correct). */
function renderUsers(authApi: IAuthApi, usersApi: IUsersApi) {
  return render(
    <MemoryRouter>
      <AuthProvider api={authApi}>
        <ToastProvider>
          <UsersPage api={usersApi} />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/**
 * The polite live region, scoped through the toast viewport's `region`
 * landmark. The page owns its own inline `role="alert"` nodes, so an unscoped
 * query would be ambiguous the day one of them renders alongside a toast.
 */
function politeRegion() {
  return within(within(screen.getByRole('region', { name: 'Notifikasi' })).getByRole('status'));
}

describe('UsersPage (QUE-43)', () => {
  beforeEach(() => {
    clearToken();
  });
  afterEach(() => {
    clearToken();
  });

  it('lists users with friendly Indonesian role labels (admin principal)', async () => {
    writeToken('t');
    const { container } = renderUsers(makeAuthApi(ADMIN), makeUsersApi().api);
    expect(await screen.findByTestId('user-row-u-1')).toBeInTheDocument();
    // Regression guard (layout-consistency refactor): the ready render path
    // must compose the shared `.page` root so it keeps the unified
    // max-width/centering/padding. `.users` carries NO geometry — without
    // `.page` the primary users view renders full-width, uncentered, no padding.
    expect(container.firstElementChild).toHaveClass('page');
    expect(screen.getByTestId('user-username-u-1')).toHaveTextContent('manajer');
    // Role is rendered via the friendly label, never the raw enum. The role
    // select's options also carry the friendly labels, so both the table cell
    // and the option text match — assert presence, not uniqueness.
    expect(screen.getAllByText('Administrator').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Staf Loket').length).toBeGreaterThan(0);
    // The raw enum never appears as visible copy (options use friendly labels).
    expect(screen.queryByText('caller-staff')).not.toBeInTheDocument();
    expect(screen.queryByText('admin')).not.toBeInTheDocument();
  });

  it('shows an access-denied notice for a non-admin (caller-staff) principal', async () => {
    writeToken('t');
    renderUsers(makeAuthApi(STAFF_PRINCIPAL), makeUsersApi().api);
    expect(await screen.findByTestId('users-denied')).toHaveTextContent(/Akses ditolak/);
    // The toolbar + add button + list are not rendered for a non-admin.
    expect(screen.queryByTestId('users-add-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('users-toolbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('users-list')).not.toBeInTheDocument();
  });

  it('disables self-delete (the current admin cannot delete their own account)', async () => {
    writeToken('t');
    // The list includes the admin's own row (u-1 == ADMIN.id).
    renderUsers(makeAuthApi(ADMIN), makeUsersApi().api);
    await screen.findByTestId('user-row-u-1');
    expect(screen.getByTestId('user-delete-u-1')).toBeDisabled();
    // A different user's delete is enabled.
    expect(screen.getByTestId('user-delete-u-2')).not.toBeDisabled();
  });

  it('creates a user via the modal and reloads the list', async () => {
    writeToken('t');
    const { api, createUser, listUsers } = makeUsersApi();
    renderUsers(makeAuthApi(ADMIN), api);
    await screen.findByTestId('user-row-u-1');

    // Open the create modal.
    await userEvent.click(screen.getByTestId('users-add-btn'));
    expect(screen.getByTestId('user-create-modal')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Username'), 'loket2');
    await userEvent.type(screen.getByLabelText('Kata sandi'), 'rahasia123');
    // The Peran <label> also wraps the hint <span>, so the label text is not
    // exactly "Peran" — match by substring.
    await userEvent.selectOptions(screen.getByLabelText('Peran', { exact: false }), 'caller-staff');
    await userEvent.click(screen.getByTestId('create-submit'));

    await waitFor(() => expect(createUser).toHaveBeenCalledWith({ username: 'loket2', password: 'rahasia123', role: 'caller-staff' }));
    // The list is reloaded after a successful create.
    expect(listUsers).toHaveBeenCalledTimes(2);
    // The modal is dismissed after a successful create.
    await waitFor(() => expect(screen.queryByTestId('user-create-modal')).not.toBeInTheDocument());
  });

  it('disables the create submit while the form is invalid', async () => {
    writeToken('t');
    renderUsers(makeAuthApi(ADMIN), makeUsersApi().api);
    await screen.findByTestId('user-row-u-1');
    // Open the create modal first — the submit + fields only mount then.
    await userEvent.click(screen.getByTestId('users-add-btn'));
    // Empty username/password → disabled.
    expect(screen.getByTestId('create-submit')).toBeDisabled();
    // Username too short + password too short → still disabled, errors shown.
    await userEvent.type(screen.getByLabelText('Username'), 'ab');
    await userEvent.type(screen.getByLabelText('Kata sandi'), '123');
    expect(screen.getByTestId('create-submit')).toBeDisabled();
    expect(screen.getByTestId('create-errors')).toBeInTheDocument();
  });

  it('deletes a user via the confirm modal', async () => {
    writeToken('t');
    const { api, deleteUser } = makeUsersApi();
    renderUsers(makeAuthApi(ADMIN), api);
    await screen.findByTestId('user-row-u-2');

    // Opening the confirm modal does NOT fire the delete immediately.
    await userEvent.click(screen.getByTestId('user-delete-u-2'));
    expect(screen.getByTestId('user-confirm-u-2')).toBeInTheDocument();
    expect(deleteUser).not.toHaveBeenCalled();

    // Confirming fires the delete + reload, then dismisses the modal.
    await userEvent.click(screen.getByTestId('user-confirm-delete-u-2'));
    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith('u-2'));
    await waitFor(() => expect(screen.queryByTestId('user-confirm-u-2')).not.toBeInTheDocument());
  });

  it('cancels a delete via the Batal button (no delete fired)', async () => {
    writeToken('t');
    const { api, deleteUser } = makeUsersApi();
    renderUsers(makeAuthApi(ADMIN), api);
    await screen.findByTestId('user-row-u-2');

    await userEvent.click(screen.getByTestId('user-delete-u-2'));
    await userEvent.click(screen.getByTestId('user-confirm-cancel-u-2'));
    expect(screen.queryByTestId('user-confirm-u-2')).not.toBeInTheDocument();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('surfaces the backend last-admin guard error when deleting the final admin fails', async () => {
    writeToken('t');
    const list = [user('u-1', 'manajer', 'admin')];
    const { api, deleteUser } = makeUsersApi(list);
    deleteUser.mockImplementation(() => Promise.reject(new Error('Tidak dapat menghapus administrator terakhir')));
    // The self-delete button is disabled for u-1 (it's the admin's own row), so
    // exercise the guard via a second admin row instead.
    list.push(user('u-3', 'manajer2', 'admin'));
    renderUsers(makeAuthApi(ADMIN), api);
    await screen.findByTestId('user-row-u-3');

    await userEvent.click(screen.getByTestId('user-delete-u-3'));
    await userEvent.click(screen.getByTestId('user-confirm-delete-u-3'));
    // The modal stays open and surfaces the backend error inside the dialog.
    expect(await screen.findByTestId('users-delete-error')).toHaveTextContent('Tidak dapat menghapus administrator terakhir');
    expect(screen.getByTestId('user-confirm-u-3')).toBeInTheDocument();
  });
  it('announces a successful create in the polite live region', async () => {
    writeToken('t');
    const { api } = makeUsersApi();
    renderUsers(makeAuthApi(ADMIN), api);
    await screen.findByTestId('user-row-u-1');

    await userEvent.click(screen.getByTestId('users-add-btn'));
    await userEvent.type(screen.getByLabelText('Username'), 'loket2');
    await userEvent.type(screen.getByLabelText('Kata sandi'), 'rahasia123');
    await userEvent.click(screen.getByTestId('create-submit'));

    // The reported gap: the modal closing is not itself a confirmation that the
    // account was created. The toast is.
    expect(await politeRegion().findByText('Pengguna "loket2" ditambahkan.')).toBeInTheDocument();
  });

  it('announces a successful delete in the polite live region', async () => {
    writeToken('t');
    const { api } = makeUsersApi();
    renderUsers(makeAuthApi(ADMIN), api);
    await screen.findByTestId('user-row-u-2');

    await userEvent.click(screen.getByTestId('user-delete-u-2'));
    await userEvent.click(screen.getByTestId('user-confirm-delete-u-2'));

    expect(await politeRegion().findByText('Pengguna "loket1" dihapus.')).toBeInTheDocument();
  });

  it('creates exactly once when the submit is double-tapped in the same tick', async () => {
    writeToken('t');
    const { api, createUser } = makeUsersApi();
    renderUsers(makeAuthApi(ADMIN), api);
    await screen.findByTestId('user-row-u-1');

    await userEvent.click(screen.getByTestId('users-add-btn'));
    await userEvent.type(screen.getByLabelText('Username'), 'loket2');
    await userEvent.type(screen.getByLabelText('Kata sandi'), 'rahasia123');

    // Both clicks MUST be batched inside one `act`. React 18 flushes a discrete
    // click update synchronously at the end of the event, so two bare
    // `fireEvent.click`s would leave `disabled` already applied before the
    // second lands — the second click never reaches the handler and the test
    // passes with or without the ref (verified by deleting the guard: still
    // green). Batching keeps `disabled` false across both, so the synchronous
    // ref is the only thing that can stop the second submit.
    const submit = screen.getByTestId('create-submit');
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });

    await waitFor(() => expect(createUser).toHaveBeenCalledTimes(1));
  });

  it('deletes exactly once when the confirm is double-tapped in the same tick', async () => {
    // Delete is the destructive mutation, so its guard is the one that most
    // needs pinning. The pre-rebase branch had this test; the merge onto the
    // modal restructure kept `deletingRef` but lost its coverage.
    writeToken('t');
    const { api, deleteUser } = makeUsersApi();
    renderUsers(makeAuthApi(ADMIN), api);
    await screen.findByTestId('user-row-u-2');

    await userEvent.click(screen.getByTestId('user-delete-u-2'));
    const confirm = screen.getByTestId('user-confirm-delete-u-2');
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(deleteUser).toHaveBeenCalledTimes(1));
  });
});
