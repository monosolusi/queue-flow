import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CategoryDto, CreatedTicketDto } from '../api/types';
import type { IKioskApi } from '../api/kiosk-api';

export interface CategorySelectPageProps {
  readonly api: IKioskApi;
}

/** Result of issuing a ticket, carried to the result page via router state. */
export interface IssuedTicket {
  readonly ticket: CreatedTicketDto;
  readonly categoryName: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; categories: readonly CategoryDto[] }
  | { status: 'error'; message: string };

type IssueState =
  | { status: 'idle' }
  | { status: 'issuing'; categoryId: string }
  | { status: 'failed'; categoryId: string; message: string };

/**
 * Kiosk home screen (FR-KSK-01 / QUE-17). Loads the active categories and
 * renders large touch buttons; selecting one POSTs to create a ticket and
 * navigates to the result page with the issued ticket. A double-tap on a
 * public touchscreen would issue two tickets, so all buttons are disabled
 * while a request is in flight. The hard guard is a synchronous ref flipped in
 * `choose` — it cannot be defeated by two clicks landing in the same tick
 * before React re-renders — and the `disabled` attribute is the visible
 * affordance of the same state.
 */
export function CategorySelectPage({ api }: CategorySelectPageProps) {
  const navigate = useNavigate();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [issue, setIssue] = useState<IssueState>({ status: 'idle' });
  // Synchronous in-flight flag: set before any await so a second click in the
  // same tick (before the disabled re-render flushes) is rejected.
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listCategories()
      .then((categories) => {
        if (!cancelled) setLoad({ status: 'loaded', categories });
      })
      .catch((err) => {
        if (!cancelled) {
          setLoad({
            status: 'error',
            message: err instanceof Error ? err.message : 'Gagal memuat daftar kategori',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function choose(category: CategoryDto) {
    // Hard double-tap guard: reject a second issue while one is in flight.
    if (inFlight.current) return;
    inFlight.current = true;
    setIssue({ status: 'issuing', categoryId: category.id });
    try {
      const ticket = await api.createTicket(category.id);
      navigate('/tiket', { state: { ticket, categoryName: category.name } satisfies IssuedTicket });
    } catch (err) {
      setIssue({
        status: 'failed',
        categoryId: category.id,
        message: err instanceof Error ? err.message : 'Gagal membuat tiket',
      });
    } finally {
      inFlight.current = false;
    }
  }

  const issuing = issue.status === 'issuing';

  return (
    <main className="kiosk-select">
      <h1 className="kiosk-select__title">Pilih Layanan</h1>

      {load.status === 'loading' && <p className="kiosk-select__hint">Memuat kategori…</p>}
      {load.status === 'error' && (
        <p className="kiosk-select__hint kiosk-select__hint--error">{load.message}</p>
      )}
      {load.status === 'loaded' && load.categories.length === 0 && (
        <p className="kiosk-select__hint">Belum ada kategori yang dikonfigurasi.</p>
      )}

      {load.status === 'loaded' && load.categories.length > 0 && (
        <ul className="kiosk-select__list">
          {load.categories.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="category-card"
                disabled={issuing}
                aria-busy={issue.status === 'issuing' && issue.categoryId === c.id}
                onClick={() => choose(c)}
              >
                <span className="category-card__code">{c.code}</span>
                <span className="category-card__name">{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {issue.status === 'failed' && (
        <p className="kiosk-select__hint kiosk-select__hint--error">{issue.message}</p>
      )}
      {issuing && <p className="kiosk-select__hint">Membuat tiket…</p>}
    </main>
  );
}