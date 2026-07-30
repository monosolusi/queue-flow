import { useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { KioskApi } from './api/kiosk-api';
import type { IKioskApi } from './api/kiosk-api';
import { CategorySelectPage } from './pages/CategorySelectPage';
import { TicketResultPage } from './pages/TicketResultPage';

/**
 * Top-level routing for the kiosk. The kiosk is a public single-purpose
 * touchscreen: the visitor picks a category (`/`) and is shown the issued
 * ticket (`/tiket`), then returns to pick the next one. There is no per-device
 * binding or auth — the flow is transient, so the issued ticket is carried in
 * router state between the two views rather than persisted.
 */
export function App({ api }: { api?: IKioskApi } = {}) {
  const kioskApi = useMemo(() => api ?? new KioskApi(), [api]);

  return (
    <Routes>
      <Route path="/" element={<CategorySelectPage api={kioskApi} />} />
      <Route path="/tiket" element={<TicketResultPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}