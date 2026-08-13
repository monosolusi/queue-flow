import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * The subset of the Web Serial API this page uses. Defined locally (no
 * `@types/w3c-web-serial` devDep — keeps the build offline and matches the
 * injectable-seam convention: `navigator.serial` is the production surface,
 * the test substitutes a fake on `navigator.serial`). `requestPort` needs a
 * user gesture, so it lives on the serial surface here (not on the provider —
 * the provider only reads already-granted ports via `getPorts` at print time).
 */
interface SerialSetupSurface {
  getPorts(): Promise<readonly { getInfo(): { usbVendorId?: number; usbProductId?: number } }[]>;
  requestPort(): Promise<{ getInfo(): { usbVendorId?: number; usbProductId?: number } }>;
}

/**
 * One-time operator pairing for a USB thermal printer cabled to the kiosk box
 * (the `usb-serial` printer mode). Web Serial's `requestPort()` REQUIRES a
 * user gesture, and the kiosk is unattended at print time — so pairing happens
 * here, on the kiosk device itself, once. The browser persists the grant per
 * origin; the {@link UsbSerialPrintProvider} then reads the granted port via
 * `getPorts()` (no gesture) on every subsequent print.
 *
 * This page is operator-only: it is NOT linked from the visitor UI. The
 * operator navigates to `/kiosk/sambung-printer` directly on the kiosk box.
 * Admin can't pair either — USB is kiosk-local, and admin is a different
 * machine (the grant is per-device, so it must be done on the kiosk).
 */
export function PrinterSetupPage() {
  const navigate = useNavigate();
  const [serial, setSerial] = useState<SerialSetupSurface | null>(null);
  const [pairedCount, setPairedCount] = useState<number | null>(null);
  // `status` describes the currently-granted port (vendor/product or "none
  // yet"); `result` describes the last pairing action outcome (success/fail).
  // Kept separate so a successful pair shows BOTH the granted-port info AND
  // the success line (refreshPaired updates status, handlePair updates result).
  const [status, setStatus] = useState<string>('');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);

  // Resolve the serial surface once on mount. `navigator.serial` is undefined
  // on non-Web-Serial browsers (e.g. iOS Safari) — the page shows the
  // unsupported message instead of the pairing button.
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const s = (navigator as unknown as { serial?: SerialSetupSurface }).serial;
    setSerial(s ?? null);
  }, []);

  const refreshPaired = useCallback(
    async (surface: SerialSetupSurface) => {
      const ports = await surface.getPorts();
      setPairedCount(ports.length);
      if (ports.length > 0) {
        const p = ports[0].getInfo();
        const v = p.usbVendorId != null ? `0x${p.usbVendorId.toString(16).padStart(4, '0')}` : '?';
        const d = p.usbProductId != null ? `0x${p.usbProductId.toString(16).padStart(4, '0')}` : '?';
        setStatus(`Printer USB terhubung (vendor ${v}, produk ${d}).`);
      } else {
        setStatus('Belum ada printer USB yang disambungkan.');
      }
    },
    [],
  );

  useEffect(() => {
    if (!serial) return;
    void refreshPaired(serial);
  }, [serial, refreshPaired]);

  const handlePair = useCallback(async () => {
    if (!serial || busy) return;
    setBusy(true);
    try {
      await serial.requestPort();
      await refreshPaired(serial);
      setResult('Printer USB berhasil disambungkan.');
    } catch {
      setResult('Gagal menyambungkan: permintaan dibatalkan atau tidak ada printer.');
    } finally {
      setBusy(false);
    }
  }, [serial, busy, refreshPaired]);

  return (
    <main className="kiosk-result" role="group" aria-label="Pasang Printer USB">
      <h1 className="kiosk-result__label">Pasang Printer USB</h1>
      <p className="kiosk-result__category">
        Sambungkan printer thermal USB ke kiosk ini, lalu tekan tombol di bawah.
      </p>

      {serial ? (
        <>
          <button
            type="button"
            className="btn btn--primary kiosk-result__done"
            onClick={handlePair}
            disabled={busy}
          >
            {busy ? 'Menyambungkan…' : 'Sambungkan Printer USB'}
          </button>
          {status && <p className="kiosk-result__category" role="status">{status}</p>}
          {result && <p className="kiosk-result__category" role="status">{result}</p>}
          {pairedCount !== null && (
            <p className="kiosk-result__category">
              Printer aktif: {pairedCount}
            </p>
          )}
        </>
      ) : (
        <p className="kiosk-result__category" role="alert">
          Browser ini tidak mendukung Web Serial. Gunakan Chrome/Edge desktop di kiosk.
        </p>
      )}

      <button
        type="button"
        className="btn kiosk-result__done"
        onClick={() => navigate('/', { replace: true })}
      >
        Kembali ke Kiosk
      </button>
    </main>
  );
}