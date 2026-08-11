import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from './toast-context';
import { useToast } from './useToast';

/** A tiny consumer that fires toasts on demand — the seam every page will use. */
function Fixture() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success('Konfigurasi tersimpan.')}>
        sukses
      </button>
      <button type="button" onClick={() => toast.error('Gagal menyimpan: kode kategori tidak valid')}>
        gagal
      </button>
      <button type="button" onClick={() => toast.info('Memuat ulang…')}>
        info
      </button>
    </>
  );
}

describe('ToastProvider', () => {
  it('mounts BOTH live regions even when there is nothing to announce', () => {
    render(
      <ToastProvider>
        <Fixture />
      </ToastProvider>,
    );
    // A live region must exist in the DOM before content is inserted, otherwise
    // polite announcements are unreliable.
    const alert = screen.getByRole('alert');
    const status = screen.getByRole('status');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(alert).toBeEmptyDOMElement();
    expect(status).toBeEmptyDOMElement();
  });

  it('names the viewport region for AT', () => {
    render(
      <ToastProvider>
        <Fixture />
      </ToastProvider>,
    );
    expect(screen.getByRole('region', { name: 'Notifikasi' })).toBeInTheDocument();
  });

  it('routes a success toast to the polite region', () => {
    render(
      <ToastProvider>
        <Fixture />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('sukses'));
    expect(within(screen.getByRole('status')).getByText('Konfigurasi tersimpan.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('routes an error toast to the assertive region', () => {
    render(
      <ToastProvider>
        <Fixture />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('gagal'));
    expect(
      within(screen.getByRole('alert')).getByText('Gagal menyimpan: kode kategori tidak valid'),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('routes an info toast to the polite region', () => {
    render(
      <ToastProvider>
        <Fixture />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('info'));
    expect(within(screen.getByRole('status')).getByText('Memuat ulang…')).toBeInTheDocument();
  });

  it('gives the toast item itself NO role (the wrapper is the region — one announcement)', () => {
    render(
      <ToastProvider>
        <Fixture />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('sukses'));
    const item = screen.getByTestId('toast-success');
    expect(item).not.toHaveAttribute('role');
    // Exactly one alert + one status in the whole tree, no nested duplicates.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('dismisses a toast via its ✕ button', () => {
    render(
      <ToastProvider>
        <Fixture />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('gagal'));
    expect(screen.getByTestId('toast-error')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tutup notifikasi' }));
    expect(screen.queryByTestId('toast-error')).not.toBeInTheDocument();
    // The region survives the dismissal — it must stay mounted.
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('keeps the variant glyph out of the accessible name', () => {
    render(
      <ToastProvider>
        <Fixture />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('sukses'));
    expect(screen.getByTestId('toast-success').querySelector('.toast__icon')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});

describe('useToast without a provider', () => {
  it('does not throw — the no-op default keeps isolation renders working', () => {
    // AdminPanel/UsersPage/AnalyticsPage/AppShell all render with no provider.
    render(<Fixture />);
    expect(() => fireEvent.click(screen.getByText('sukses'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByText('gagal'))).not.toThrow();
    // Nothing is rendered — the notification is dropped, never a crash.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
