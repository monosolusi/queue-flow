import { Body, Controller, HttpCode, HttpException, HttpStatus, Post } from '@nestjs/common';
import { PrintTicketUseCase } from '../../application/store-config';
import type { TicketPrintPayload } from '../../domain/store-config/printer-driver.port';
import {
  InvalidArgumentException,
  PrinterNotNetworkException,
  SystemNotConfiguredException,
} from '../../domain/shared';

/** The minimal structural shape of the kiosk print request body. The fields
 *  are validated at the transport boundary before reaching the use case. */
interface PrintRequestBody {
  ticketNumber?: unknown;
  categoryName?: unknown;
  storeName?: unknown;
  issuedAt?: unknown;
  waitingAhead?: unknown;
}

/**
 * Kiosk print-proxy REST surface (FR-printer-config). `POST /api/print/ticket`
 * proxies a kiosk print request to a network ESC/POS printer through core-api
 * (a browser PWA cannot open raw TCP sockets, so the LAN-attached printer is
 * proxied through the only process permitted to use Node's `net`).
 *
 * PUBLIC — no guard (like `POST /api/tickets`): the kiosk is an unattended
 * touchscreen on the store LAN (NFR-SEC-01), and the print payload references a
 * ticket that was already created (and persisted) by the kiosk's authenticated
 * `POST /api/tickets`. This endpoint does NOT touch the queue repo; it is a
 * best-effort echo of an already-persisted ticket to a physical printer.
 *
 * Response contract:
 * - `204 No Content` on a clean send.
 * - `400` on a malformed body (missing/typed-wrong ticketNumber/categoryName/
 *   issuedAt/waitingAhead).
 * - `409 { code: 'PRINTER_NOT_NETWORK' }` when the persisted
 *   `printerConfiguration.mode` is not `network-escpos` (the kiosk only calls
 *   this when mode is network-escpos — this is a safety guard against a config
 *   change between the kiosk reading the config and posting).
 * - `409 { code: 'SYSTEM_NOT_CONFIGURED' }` when no config exists at all.
 * - `502 { code: 'PRINTER_UNREACHABLE' }` when the TCP send to the printer
 *   fails or times out (the driver rejects).
 *
 * This controller does its own exception mapping (it does NOT rely on the
 * global `DomainExceptionFilter`) so the print endpoint's error envelope is
 * the pinned `{ code, message }` shape, distinct from the filter's
 * `{ statusCode, code, error, message }` shape.
 */
@Controller('api/print')
export class PrintController {
  constructor(private readonly printTicket: PrintTicketUseCase) {}

  /** `POST /api/print/ticket` → 204 on success, 400/409/502 per the contract. */
  @Post('ticket')
  @HttpCode(HttpStatus.NO_CONTENT)
  async ticket(@Body() body: PrintRequestBody): Promise<void> {
    const payload = parsePrintPayload(body);
    try {
      await this.printTicket.execute(payload);
    } catch (e) {
      if (e instanceof PrinterNotNetworkException) {
        throw new HttpException(
          { code: 'PRINTER_NOT_NETWORK', message: e.message },
          HttpStatus.CONFLICT,
        );
      }
      if (e instanceof SystemNotConfiguredException) {
        throw new HttpException(
          { code: 'SYSTEM_NOT_CONFIGURED', message: e.message },
          HttpStatus.CONFLICT,
        );
      }
      if (e instanceof InvalidArgumentException) {
        // A null-driver wiring guard is a server misconfiguration (500-class),
        // not an upstream-printer failure (502). Unreachable in production —
        // PrintingApiModule always binds EscPosPrinterDriver under PRINTER_DRIVER
        // — but if it fires, the operator gets a distinct code, not 502.
        throw new HttpException(
          { code: 'PRINTER_NOT_WIRED', message: e.message },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      // Any other error (driver TCP failure, connect timeout) → 502
      // PRINTER_UNREACHABLE. The driver throws a plain Error on TCP failure; its
      // message names the printer/host for the operator.
      throw new HttpException(
        { code: 'PRINTER_UNREACHABLE', message: (e as Error).message },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}

/**
 * Validates the kiosk print body at the transport boundary and returns the
 * typed {@link TicketPrintPayload}. Throws `BadRequestException` (→ 400) on a
 * malformed body — the body is untrusted HTTP, so the declared types are not
 * earned until this guard runs. Mirrors the boundary-validation style of the
 * system-config controller.
 */
function parsePrintPayload(body: PrintRequestBody): TicketPrintPayload {
  const { ticketNumber, categoryName, storeName, issuedAt, waitingAhead } = body ?? {};
  const errs: string[] = [];
  if (typeof ticketNumber !== 'string' || ticketNumber.trim() === '') {
    errs.push("body field 'ticketNumber' must be a non-empty string");
  }
  if (typeof categoryName !== 'string' || categoryName.trim() === '') {
    errs.push("body field 'categoryName' must be a non-empty string");
  }
  if (storeName !== undefined && typeof storeName !== 'string') {
    errs.push("body field 'storeName' must be a string when present");
  }
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    errs.push("body field 'issuedAt' must be a finite number (epoch ms)");
  }
  if (typeof waitingAhead !== 'number' || !Number.isInteger(waitingAhead) || waitingAhead < 0) {
    errs.push("body field 'waitingAhead' must be a non-negative integer");
  }
  if (errs.length > 0) {
    throw new HttpException(
      { code: 'INVALID_PRINT_PAYLOAD', message: errs.join('; ') },
      HttpStatus.BAD_REQUEST,
    );
  }
  return {
    ticketNumber: ticketNumber as string,
    categoryName: categoryName as string,
    storeName: storeName as string | undefined,
    issuedAt: issuedAt as number,
    waitingAhead: waitingAhead as number,
  };
}