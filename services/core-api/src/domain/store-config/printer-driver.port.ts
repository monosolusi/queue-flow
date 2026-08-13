import type { PrinterConfiguration } from './value-objects/printer-configuration';

/**
 * The server-side mirror of the kiosk's print payload. Pure data — no
 * framework/IO imports (NFR-MNT-01) — so the application-layer `PrintTicketUseCase`
 * can depend on it without leaking the transport. The kiosk POSTs this exact
 * shape to `POST /api/print/ticket`; the controller validates it and hands it
 * to the use case, which forwards it to {@link IPrinterDriver.print}.
 */
export interface TicketPrintPayload {
  readonly ticketNumber: string;
  readonly categoryName: string;
  readonly storeName?: string;
  readonly issuedAt: number;
  readonly waitingAhead: number;
}

/**
 * Application-side port for sending a receipt to a physical ESC/POS printer
 * over a raw TCP socket (FR-printer-config). A browser PWA cannot open raw TCP
 * sockets, so a network ESC/POS printer is proxied through core-api (the only
 * process permitted to use Node's `net`): the kiosk POSTs the print payload,
 * the use case loads the persisted {@link PrinterConfiguration}, and — when
 * `mode === 'network-escpos'` — hands both to this port's concrete
 * implementation, which composes the ESC/POS byte stream (init, header, body,
 * feed, cut) and streams it to `host:port`.
 *
 * This is a non-repository domain port (like `IDailyResetSchedulerPort` /
 * `ITransitionPolicyResolver`): the implementation owns the TCP I/O (`net.Socket`)
 * and lives in infrastructure, while the use case depends on this abstraction
 * (DIP) and never on `net` directly — `application-no-framework-imports` holds.
 * Pure interface + Symbol token — no framework/IO imports, so domain purity
 * (NFR-MNT-01) holds.
 *
 * Printing is fire-and-forget best-effort: the ticket is already persisted by
 * the kiosk's `createTicket` (the queue repo is NOT touched here). A driver
 * failure (TCP connect refused / timeout) rejects the promise so the
 * controller maps it to 502 `PRINTER_UNREACHABLE`; it is not a domain error and
 * writes nothing to the audit log (the print job itself is not an audited act).
 */
export const PRINTER_DRIVER = Symbol('PRINTER_DRIVER');

export interface IPrinterDriver {
  /**
   * Compose the ESC/POS receipt for `payload` per `config` (paper width → column
   * wrap, cut mode → cut command) and stream the bytes to the configured
   * `host:port`. Resolves on a clean end; rejects on a connect / write error or
   * a connect timeout (the controller maps the rejection to 502).
   *
   * Precondition: `config.mode === 'network-escpos'` (the use case guards this
   * before calling; the driver may assert it but is not required to, since a
   * chrome-mode config has no host and a TCP send would fail anyway).
   */
  print(payload: TicketPrintPayload, config: PrinterConfiguration): Promise<void>;
}