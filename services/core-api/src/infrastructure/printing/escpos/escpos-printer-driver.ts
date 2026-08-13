import { Socket } from 'net';
import type { IPrinterDriver, TicketPrintPayload } from '../../../domain/store-config/printer-driver.port';
import type { PrinterConfiguration } from '../../../domain/store-config/value-objects/printer-configuration';
import { composeReceipt } from './escpos-commands';

/**
 * A factory that returns a fresh TCP socket for one print job. Injectable so
 * unit tests substitute a fake socket (no real network connection). The
 * production binding uses {@link defaultSocketFactory} (a plain `new Socket()`).
 */
export type SocketFactory = () => Socket;

/** The production socket factory — a fresh `net.Socket` per print job. */
export const defaultSocketFactory: SocketFactory = () => new Socket();

/**
 * Concrete {@link IPrinterDriver} that sends ESC/POS bytes over a raw TCP socket
 * to a network ESC/POS printer (FR-printer-config). The only place in the
 * codebase permitted to import Node's `net` for printing — domain + application
 * depend on the {@link IPrinterDriver} port (DIP), never on this concretion
 * (`application-no-framework-imports` / `domain-no-framework-imports` hold).
 *
 * `print()` is a single connect → write → end → close cycle guarded by a
 * connect timeout. A connect error, write error, or timeout rejects the promise
 * so the print controller maps it to 502 `PRINTER_UNREACHABLE`; a clean end
 * resolves. The socket is always destroyed on settlement (no fd leak). The
 * `SocketFactory` is the test seam: tests inject a fake factory returning a
 * controllable fake socket instead of opening a real connection.
 */
export class EscPosPrinterDriver implements IPrinterDriver {
  constructor(
    private readonly timeoutMs = 5000,
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
  ) {}

  public async print(payload: TicketPrintPayload, config: PrinterConfiguration): Promise<void> {
    // The use case already guards `mode === 'network-escpos'`; the config
    // carries a non-empty host + validated port. Compose the bytes per the
    // paper width + cut mode, then stream them to the printer.
    const bytes = composeReceipt(payload, config.paperWidth, config.cutMode);
    await this.send(config.host, config.port, bytes);
  }

  private send(host: string, port: number, bytes: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory();
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error('printer connect timeout')),
        this.timeoutMs,
      );
      socket.connect(port, host, () => {
        socket.write(bytes, (writeErr) => {
          if (writeErr) {
            finish(writeErr);
            return;
          }
          // Half-close our side once the bytes are flushed; the printer's close
          // resolves the promise (the receipt is sent).
          socket.end(() => finish());
        });
      });
      socket.on('error', (err) => finish(err));
      // `close` after `end` without a prior `error` is a clean send → resolve.
      socket.on('close', () => finish());
    });
  }
}