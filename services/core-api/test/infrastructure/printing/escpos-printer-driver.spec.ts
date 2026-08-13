import { EventEmitter } from 'events';
import type { Socket } from 'net';
import { Buffer } from 'buffer';
import { EscPosPrinterDriver } from '../../../src/infrastructure/printing/escpos/escpos-printer-driver';
import type { SocketFactory } from '../../../src/infrastructure/printing/escpos/escpos-printer-driver';
import { PrinterConfiguration } from '../../../src/domain/store-config/value-objects/printer-configuration';
import type { TicketPrintPayload } from '../../../src/domain/store-config/printer-driver.port';

/**
 * `EscPosPrinterDriver` — streams ESC/POS bytes over a raw TCP socket. The
 * `SocketFactory` is the test seam: this spec injects a fake factory returning
 * a controllable {@link FakeSocket} (an `EventEmitter` + the connect/write/end
 * /destroy methods the driver calls) instead of opening a real connection. No
 * real socket, no real network.
 */

/** A controllable stand-in for `net.Socket`. The driver calls
 *  `connect`/`write`/`end`/`on('error')`/`on('close')`/`destroy`; the test drives
 *  each of those to assert the driver's settle behavior. */
class FakeSocket extends EventEmitter {
  connectCalls: { port: number; host: string }[] = [];
  written: Buffer[] = [];
  destroyed = false;
  ended = false;
  private connectCb: (() => void) | null = null;
  private writeCb: ((err: Error | null | undefined) => void) | null = null;
  private endCb: (() => void) | null = null;

  connect(port: number, host: string, cb: () => void): this {
    this.connectCalls.push({ port, host });
    this.connectCb = cb;
    return this;
  }

  write(data: Buffer, cb: (err: Error | null | undefined) => void): boolean {
    this.written.push(Buffer.from(data));
    this.writeCb = cb;
    return true;
  }

  end(cb?: () => void): this {
    this.ended = true;
    this.endCb = cb ?? null;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  // --- test control surface ---

  /** Simulate a successful TCP connect: fire the connect callback. */
  fireConnect(): void {
    this.connectCb?.();
  }

  /** Simulate a successful write flush: fire the write callback with no error. */
  fireWrite(): void {
    this.writeCb?.(undefined);
  }

  /** Simulate a clean socket end after flush: fire the end callback. */
  fireEnd(): void {
    this.endCb?.();
  }

  /** Simulate a TCP error (connect refused / write error). */
  fireError(err: Error): void {
    this.emit('error', err);
  }
}

function fakeFactory(): { factory: SocketFactory; socket: FakeSocket } {
  const socket = new FakeSocket();
  const factory: SocketFactory = () => socket as unknown as Socket;
  return { factory, socket };
}

const networkConfig = PrinterConfiguration.of({
  mode: 'network-escpos',
  host: '192.168.1.50',
  port: 9100,
  paperWidth: 80,
  cutMode: 'partial',
});

const payload: TicketPrintPayload = {
  ticketNumber: 'A-001',
  categoryName: 'Customer Service',
  storeName: 'Toko',
  issuedAt: 0,
  waitingAhead: 0,
};

describe('EscPosPrinterDriver', () => {
  it('resolves on a clean connect → write → end cycle', async () => {
    const { factory, socket } = fakeFactory();
    const driver = new EscPosPrinterDriver(5000, factory);

    const promise = driver.print(payload, networkConfig);
    expect(socket.connectCalls).toEqual([{ port: 9100, host: '192.168.1.50' }]);

    socket.fireConnect();
    // Bytes were composed + written (contains the ticket number as UTF-8).
    expect(socket.written.length).toBe(1);
    expect(socket.written[0].includes(Buffer.from('A-001', 'utf8'))).toBe(true);
    socket.fireWrite();
    expect(socket.ended).toBe(true);
    socket.fireEnd();

    await expect(promise).resolves.toBeUndefined();
    expect(socket.destroyed).toBe(true);
  });

  it('rejects on a connect error (TCP refused) → 502', async () => {
    const { factory, socket } = fakeFactory();
    const driver = new EscPosPrinterDriver(5000, factory);

    const promise = driver.print(payload, networkConfig);
    socket.fireError(new Error('ECONNREFUSED'));

    await expect(promise).rejects.toThrow('ECONNREFUSED');
    expect(socket.destroyed).toBe(true);
  });

  it('rejects on a write error → 502', async () => {
    const { factory, socket } = fakeFactory();
    const driver = new EscPosPrinterDriver(5000, factory);

    const promise = driver.print(payload, networkConfig);
    socket.fireConnect();
    socket.fireWrite(); // write callback not used for error; emit instead
    socket.fireError(new Error('write EPIPE'));

    await expect(promise).rejects.toThrow('write EPIPE');
  });

  it('rejects on a connect timeout (never connects) → 502', async () => {
    const { factory, socket } = fakeFactory();
    const driver = new EscPosPrinterDriver(20, factory); // 20ms timeout

    const promise = driver.print(payload, networkConfig);
    // Never fire connect → the timeout rejects.
    await expect(promise).rejects.toThrow('printer connect timeout');
    expect(socket.destroyed).toBe(true);
  }, 5000);

  it('composes bytes for the configured paper width + cut mode', async () => {
    const { factory, socket } = fakeFactory();
    const driver = new EscPosPrinterDriver(5000, factory);
    const cfg = PrinterConfiguration.of({ mode: 'network-escpos', host: 'h', port: 9100, paperWidth: 58, cutMode: 'full' });

    const promise = driver.print(payload, cfg);
    socket.fireConnect();
    socket.fireWrite();
    socket.fireEnd();
    await promise;

    // 58mm → 32 cols (not 48); full cut → GS V 0.
    expect(socket.written[0].includes(Buffer.from([0x1d, 0x56, 0x00]))).toBe(true);
    expect(socket.written[0].includes(Buffer.from([0x1d, 0x56, 0x01]))).toBe(false);
  });
});