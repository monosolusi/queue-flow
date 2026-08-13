import type { ISystemConfigurationRepository } from '../../domain/store-config';
import type { IPrinterDriver, TicketPrintPayload } from '../../domain/store-config';
import {
  InvalidArgumentException,
  PrinterNotNetworkException,
  SystemNotConfiguredException,
} from '../../domain/shared';

/**
 * Proxies a kiosk print request to a network ESC/POS printer (FR-printer-config).
 *
 * A browser PWA cannot open raw TCP sockets, so a network ESC/POS printer is
 * proxied through core-api (the only process permitted to use Node's `net`):
 * the kiosk POSTs a {@link TicketPrintPayload} to `POST /api/print/ticket`, this
 * use case loads the persisted {@link PrinterConfiguration}, and — when
 * `mode === 'network-escpos'` — hands the payload + config to the
 * {@link IPrinterDriver} port, whose concrete implementation composes the
 * ESC/POS byte stream (init, header, body, feed, cut) and streams it over TCP
 * to `host:port`.
 *
 * Depends ONLY on ports (DIP): the config repository (to read the printer
 * config) and the printer driver (the TCP I/O abstraction). No ORM, HTTP, or
 * `net` imports — `application-no-framework-imports` holds. The driver concretion
 * lives in infrastructure; this use case never references it.
 *
 * Printing is fire-and-forget best-effort: the ticket is already persisted by
 * the kiosk's `CreateTicketUseCase` (`POST /api/tickets`), so this endpoint does
 * NOT touch the queue repo and writes no audit entry (the print job itself is
 * not an audited act — it is an operational echo of an already-audited ticket
 * creation). A driver failure (TCP connect refused / timeout) rejects the
 * promise so the controller maps it to 502 `PRINTER_UNREACHABLE`.
 *
 * `driver` is optional with a null default so unit tests can construct the use
 * case with just the config repository and inject a fake driver — mirroring the
 * optional-port pattern in `SaveSystemConfigurationUseCase` (the
 * interface-adapter layer wires the concrete `EscPosPrinterDriver` under the
 * `PRINTER_DRIVER` token).
 */
export class PrintTicketUseCase {
  constructor(
    private readonly config: ISystemConfigurationRepository,
    private readonly driver: IPrinterDriver | null = null,
  ) {}

  public async execute(payload: TicketPrintPayload): Promise<void> {
    const cfg = await this.config.get();
    if (!cfg) {
      // No config at all — the first-run wizard has not completed. The kiosk
      // only reaches this endpoint after setup, so this is a defensive guard.
      // Maps to 409 SYSTEM_NOT_CONFIGURED via the print controller.
      throw new SystemNotConfiguredException();
    }
    const printer = cfg.printerConfiguration;
    // The kiosk only calls /api/print/ticket when mode is network-escpos; this
    // is a safety guard against a config change between the kiosk reading the
    // config and posting the payload. Maps to 409 PRINTER_NOT_NETWORK.
    if (printer.mode !== 'network-escpos') {
      throw new PrinterNotNetworkException();
    }
    if (!this.driver) {
      // No driver wired — a wiring error, not a runtime printer failure. Unit
      // tests construct the use case with a null driver; production wires the
      // EscPosPrinterDriver. A null driver here means the module is mis-wired.
      throw new InvalidArgumentException('printer driver is not wired');
    }
    // The driver composes the ESC/POS bytes per `printer` (paper width → column
    // wrap, cut mode → cut command) and streams them to `printer.host:port`.
    // A TCP connect/write error or timeout rejects so the controller maps it to
    // 502 PRINTER_UNREACHABLE. The use case does not catch — it propagates.
    await this.driver.print(payload, printer);
  }
}