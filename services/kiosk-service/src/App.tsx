import { useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { KioskApi } from './api/kiosk-api';
import type { IKioskApi } from './api/kiosk-api';
import { CategorySelectPage } from './pages/CategorySelectPage';
import { TicketResultPage } from './pages/TicketResultPage';
import { BrowserPrintProvider } from './print/print-provider';
import type { IPrintProvider } from './print/print-provider';

/**
 * Top-level routing for the kiosk. The kiosk is a public single-purpose
 * touchscreen: the visitor picks a category (`/`) and is shown the issued
 * ticket (`/tiket`), then returns to pick the next one. There is no per-device
 * binding or auth — the flow is transient, so the issued ticket is carried in
 * router state between the two views rather than persisted.
 *
 * A {@link BrowserPrintProvider} is wired by default so a physical ticket
 * prints on tap (FR-KSK-02/03); inject a different `IPrintProvider` (e.g. an
 * ESC/POS-over-Serial provider) or `api` for tests.
 */
export function App({
  api,
  printProvider,
}: { api?: IKioskApi; printProvider?: IPrintProvider } = {}) {
  const kioskApi = useMemo(() => api ?? new KioskApi(), [api]);
  const printer = useMemo(() => printProvider ?? new BrowserPrintProvider(), [printProvider]);

  return (
    <Routes>
      <Route path="/" element={<CategorySelectPage api={kioskApi} printProvider={printer} />} />
      <Route path="/tiket" element={<TicketResultPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}