import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { createServer, type Server, type Socket } from 'net';
import { AppModule } from '../../src/app.module';
import {
  type ISystemConfigurationRepository,
  SYSTEM_CONFIGURATION_REPOSITORY,
  SystemConfiguration,
  PrinterConfiguration,
} from '../../src/domain/store-config';
import { Identifier } from '../../src/domain/shared';

/**
 * Integration: boots the real Nest app (in-memory) and exercises the kiosk
 * print-proxy REST surface (`POST /api/print/ticket` — FR-printer-config). The
 * endpoint is PUBLIC (no auth guard). The response contract:
 *  - 204 on a clean send (a real local TCP echo server accepts the bytes),
 *  - 400 on a malformed body,
 *  - 409 `PRINTER_NOT_NETWORK` when mode is chrome,
 *  - 409 `SYSTEM_NOT_CONFIGURED` when no config exists,
 *  - 502 `PRINTER_UNREACHABLE` when the TCP connect fails.
 */
describe('Print-proxy REST surface (integration — FR-printer-config)', () => {
  let app: INestApplication;
  let config: ISystemConfigurationRepository;
  let echo: Server;
  let closedPort: number;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    config = app.get(SYSTEM_CONFIGURATION_REPOSITORY);
    // A local TCP server that accepts a connection then immediately half-closes
    // — the real `EscPosPrinterDriver` connects, writes the ESC/POS bytes,
    // ends, and the clean close resolves the print → 204. No real printer.
    // Connections are tracked so afterAll can destroy any that linger (a
    // half-closed socket can otherwise keep `server.close()` pending).
    echo = createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.end();
    });
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    // A guaranteed-closed port: bind a server on an ephemeral port, read the
    // port, close it — connect attempts now ECONNREFUSED immediately (no 5s
    // driver-timeout wait) for the 502 test.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    closedPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  afterAll(async () => {
    await app.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }, 20000);

  beforeEach(async () => {
    (config as { clear?: () => void }).clear?.();
  });

  function seedPrinter(printer: PrinterConfiguration): void {
    const d = SystemConfiguration.create(Identifier.generate());
    const cfg = SystemConfiguration.reconstitute({
      id: Identifier.generate(),
      storeName: 'Toko Cetak',
      isInitialSetupCompleted: true,
      stateMachine: d.stateMachine,
      dailyResetPolicy: d.dailyResetPolicy,
      brandColor: d.brandColor,
      serviceThemes: d.serviceThemes,
      tvPanelLayout: d.tvPanelLayout,
      edgeRoutingLayout: d.edgeRoutingLayout,
      nodePositions: d.nodePositions,
      nodeActions: d.nodeActions,
      terminalNodes: d.terminalNodes,
      printerConfiguration: printer,
    });
    void config.save(cfg);
  }

  function printBody() {
    return {
      ticketNumber: 'A-001',
      categoryName: 'Customer Service',
      storeName: 'Toko Cetak',
      issuedAt: 1_700_000_000_000,
      waitingAhead: 3,
    };
  }

  it('POST /api/print/ticket → 204 on a clean send to a network ESC/POS printer', async () => {
    const port = (echo.address() as { port: number }).port;
    seedPrinter(
      PrinterConfiguration.of({ mode: 'network-escpos', host: '127.0.0.1', port, paperWidth: 80, cutMode: 'partial' }),
    );
    const res = await request(app.getHttpServer()).post('/api/print/ticket').send(printBody());
    expect(res.status).toBe(204);
  });

  it('POST /api/print/ticket → 409 PRINTER_NOT_NETWORK when mode is chrome', async () => {
    seedPrinter(PrinterConfiguration.of({ mode: 'chrome' }));
    const res = await request(app.getHttpServer()).post('/api/print/ticket').send(printBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRINTER_NOT_NETWORK');
  });

  it('POST /api/print/ticket → 409 SYSTEM_NOT_CONFIGURED when no config exists (clean store)', async () => {
    // No seed — clean store.
    const res = await request(app.getHttpServer()).post('/api/print/ticket').send(printBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYSTEM_NOT_CONFIGURED');
  });

  it('POST /api/print/ticket → 502 PRINTER_UNREACHABLE when the TCP connect fails', async () => {
    // A guaranteed-closed port (bound + released in beforeAll) → ECONNREFUSED
    // immediately (no 5s driver-timeout wait), so the test stays fast.
    seedPrinter(
      PrinterConfiguration.of({ mode: 'network-escpos', host: '127.0.0.1', port: closedPort, paperWidth: 80, cutMode: 'full' }),
    );
    const res = await request(app.getHttpServer()).post('/api/print/ticket').send(printBody());
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PRINTER_UNREACHABLE');
  }, 15000);

  it('POST /api/print/ticket → 400 on a malformed body (missing ticketNumber)', async () => {
    const port = (echo.address() as { port: number }).port;
    seedPrinter(
      PrinterConfiguration.of({ mode: 'network-escpos', host: '127.0.0.1', port, paperWidth: 80, cutMode: 'partial' }),
    );
    const res = await request(app.getHttpServer())
      .post('/api/print/ticket')
      .send({ categoryName: 'CS', issuedAt: 0, waitingAhead: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PRINT_PAYLOAD');
  });

  it('POST /api/print/ticket → 400 on a malformed body (non-number waitingAhead)', async () => {
    const port = (echo.address() as { port: number }).port;
    seedPrinter(
      PrinterConfiguration.of({ mode: 'network-escpos', host: '127.0.0.1', port, paperWidth: 80, cutMode: 'partial' }),
    );
    const res = await request(app.getHttpServer())
      .post('/api/print/ticket')
      .send({ ticketNumber: 'A-001', categoryName: 'CS', issuedAt: 0, waitingAhead: 'three' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PRINT_PAYLOAD');
  });

  it('POST /api/print/ticket → 400 on a malformed body (negative waitingAhead)', async () => {
    const port = (echo.address() as { port: number }).port;
    seedPrinter(
      PrinterConfiguration.of({ mode: 'network-escpos', host: '127.0.0.1', port, paperWidth: 80, cutMode: 'partial' }),
    );
    const res = await request(app.getHttpServer())
      .post('/api/print/ticket')
      .send({ ticketNumber: 'A-001', categoryName: 'CS', issuedAt: 0, waitingAhead: -1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PRINT_PAYLOAD');
  });
});