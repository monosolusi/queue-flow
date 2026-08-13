import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { KioskApi } from './api/kiosk-api';
import type { IKioskApi } from './api/kiosk-api';
import type { StoreProfileSlice } from './api/types';
import { CategorySelectPage } from './pages/CategorySelectPage';
import { TicketResultPage } from './pages/TicketResultPage';
import {
  BrowserPrintProvider,
  NetworkEscPosPrintProvider,
} from './print/print-provider';
import type { IPrintProvider } from './print/print-provider';

/**
 * Builds the print provider from the loaded store profile (FR-KSK-02).
 * `network-escpos` POSTs the ticket to core-api's ESC/POS proxy; `chrome`
 * (default) renders the receipt in a hidden iframe and opens Chrome's print
 * dialog at the configured paper width. The provider switch happens once on
 * mount — the kiosk is REST-only by design (no WS config subscription), so a
 * manager config change takes effect on the next kiosk reload (acceptable for
 * v1; the kiosk is a transient surface, not long-lived).
 */
function buildPrintProvider(profile: StoreProfileSlice, api: IKioskApi): IPrintProvider {
  if (profile.printerMode === 'network-escpos') {
    return new NetworkEscPosPrintProvider((payload) => api.printTicket(payload));
  }
  return new BrowserPrintProvider({ paperWidth: profile.printerPaperWidth });
}

/**
 * Top-level routing for the kiosk. The kiosk is a public single-purpose
 * touchscreen: the visitor picks a category (`/`) and is shown the issued
 * ticket (`/tiket`), then returns to pick the next one. There is no per-device
 * binding or auth — the flow is transient, so the issued ticket is carried in
 * router state between the two views rather than persisted.
 *
 * A {@link BrowserPrintProvider} (chrome 80mm) is wired by default so a physical
 * ticket prints on tap (FR-KSK-02/03); the manager-configured printer mode +
 * paper width are loaded from the store profile on mount and swap the provider.
 * Inject a different `IPrintProvider` or `api` for tests (the injected
 * provider is authoritative — it is never overridden by the config fetch).
 */
export function App({
  api,
  printProvider,
}: { api?: IKioskApi; printProvider?: IPrintProvider } = {}) {
  const kioskApi = useMemo(() => api ?? new KioskApi(), [api]);
  // Default to the prior behavior (chrome 80mm) until the store profile loads.
  // When a `printProvider` is injected (test seam) it is authoritative and the
  // config fetch is skipped entirely.
  const [printer, setPrinter] = useState<IPrintProvider>(
    () => printProvider ?? new BrowserPrintProvider({ paperWidth: 80 }),
  );

  useEffect(() => {
    // An injected provider is the test seam — never override it with config.
    if (printProvider) return;
    let cancelled = false;
    kioskApi
      .getStoreProfile()
      .then((profile) => {
        if (cancelled) return;
        setPrinter(buildPrintProvider(profile, kioskApi));
      })
      .catch(() => {
        /* config fetch failure → keep the default chrome 80mm (prior behavior) */
      });
    return () => {
      cancelled = true;
    };
  }, [kioskApi, printProvider]);

  return (
    <Routes>
      <Route path="/" element={<CategorySelectPage api={kioskApi} printProvider={printer} />} />
      <Route path="/tiket" element={<TicketResultPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}