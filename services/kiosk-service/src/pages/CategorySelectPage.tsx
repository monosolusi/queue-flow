import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CategoryDto, CreatedTicketDto } from '../api/types';
import type { IKioskApi } from '../api/kiosk-api';
import { applyBrandColor } from '../lib/theme';
import type { IPrintProvider, PrintPayload } from '../print/print-provider';

export interface CategorySelectPageProps {
  readonly api: IKioskApi;
  /** Thermal print provider (FR-KSK-02/03). When present, the kiosk fires a
   * print immediately after a ticket is issued — within the 1.5 s budget
   * (NFR-PERF-03). Optional so existing flows/tests without a printer are
   * unbroken; the App wires a {@link BrowserPrintProvider} by default. */
  readonly printProvider?: IPrintProvider;
}

/**
 * Result of issuing a ticket, carried to the result page via router state.
 * Display-only contract: carries the fields `TicketResultPage` renders
 * (`ticketNumber`, `categoryName`) — NOT the `waitingAhead` / `storeName` a
 * `PrintPayload` requires. Printing is fired here in `choose` before navigating;
 * the result page must not attempt to print from this state.
 */
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
export function CategorySelectPage({ api, printProvider }: CategorySelectPageProps) {
  const navigate = useNavigate();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [issue, setIssue] = useState<IssueState>({ status: 'idle' });
  // Store name for the receipt header (FR-KSK-03 "Nama Toko"). Fetched once on
  // mount — off the touch→print hot path, so it adds no latency to the 1.5 s
  // budget (NFR-PERF-03). A fetch failure leaves the name empty (the receipt
  // header is optional); the store-name line is omitted when blank. The same
  // fetch also carries the brand color (QUE-37 AC6) applied to `--accent`.
  const [storeName, setStoreName] = useState('');
  // Synchronous in-flight flag: set before any await so a second click in the
  // same tick (before the disabled re-render flushes) is rejected.
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Await categories + store profile together (both off the touch→print hot
    // path) so the store name is resolved before the category buttons become
    // interactive — otherwise a fast tap before `getStoreProfile()` settled
    // would print a receipt with no store-name header (FR-KSK-03). A store-name
    // *failure* never blocks the kiosk flow: the receipt just omits the header
    // line (it is optional in PrintPayload). `allSettled` so a store-profile
    // rejection does not delay the categories. The brand color is applied to
    // `--accent` on the same settle (QUE-37 AC6); the static `#2563eb` default
    // stays in place on rejection (no flash — it IS the default).
    Promise.allSettled([api.listCategories(), api.getStoreProfile()]).then(([catRes, profileRes]) => {
      if (cancelled) return;
      if (catRes.status === 'fulfilled') {
        setLoad({ status: 'loaded', categories: catRes.value });
      } else {
        setLoad({
          status: 'error',
          message:
            catRes.reason instanceof Error ? catRes.reason.message : 'Gagal memuat daftar kategori',
        });
      }
      if (profileRes.status === 'fulfilled') {
        setStoreName(profileRes.value.storeName ?? '');
        applyBrandColor(profileRes.value.brandColor);
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
      // Fire the thermal print immediately after issuance (FR-KSK-02/03,
      // NFR-PERF-03 < 1.5 s). Print is fire-and-forget: the print dialog / ESC/POS
      // handoff must never block the result screen, and a print failure is
      // non-fatal (the result page is the source of truth). The provider is an
      // OCP extension point — the page never knows the print mechanism.
      if (printProvider) {
        const payload: PrintPayload = {
          ticketNumber: ticket.ticketNumber,
          categoryName: category.name,
          storeName: storeName || undefined,
          issuedAt: Date.now(),
          waitingAhead: ticket.waitingAhead,
        };
        void printProvider.print(payload).catch(() => {
          /* print failure is non-fatal — the result screen shows the ticket */
        });
      }
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

      {load.status === 'loading' && (
        <p className="kiosk-select__hint" aria-live="polite">
          Memuat kategori…
        </p>
      )}
      {load.status === 'error' && (
        <p className="kiosk-select__hint kiosk-select__hint--error" role="alert">
          {load.message}
        </p>
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
                className="category-card pressable"
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
        <p className="kiosk-select__hint kiosk-select__hint--error" role="alert">
          {issue.message}
        </p>
      )}
      {issuing && (
        <p className="kiosk-select__hint" aria-live="polite">
          Membuat tiket…
        </p>
      )}
    </main>
  );
}