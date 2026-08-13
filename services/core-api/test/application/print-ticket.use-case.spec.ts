import { PrintTicketUseCase } from '../../src/application/store-config/print-ticket.use-case';
import {
  type IPrinterDriver,
  type TicketPrintPayload,
  PRINTER_DRIVER,
} from '../../src/domain/store-config/printer-driver.port';
import {
  PrinterConfiguration,
  SystemConfiguration,
} from '../../src/domain/store-config';
import type { ISystemConfigurationRepository } from '../../src/domain/store-config';
import { Identifier } from '../../src/domain/shared';
import {
  InvalidArgumentException,
  PrinterNotNetworkException,
  SystemNotConfiguredException,
} from '../../src/domain/shared/errors';
import { InMemorySystemConfigurationRepository } from '../../src/infrastructure/persistence/in-memory';

/**
 * `PrintTicketUseCase` — proxies a kiosk print request to a network ESC/POS
 * printer through the {@link IPrinterDriver} port. Depends only on the config
 * repository + the driver port (DIP); a fake driver records the call so the
 * spec never opens a real TCP socket.
 */
describe('PrintTicketUseCase', () => {
  /** A recording fake of {@link IPrinterDriver}. The `PRINTER_DRIVER` import is
   *  only to reference the token symbol for documentation; the fake satisfies
   *  the interface structurally. */
  function fakeDriver(): { driver: IPrinterDriver; calls: { payload: TicketPrintPayload; config: PrinterConfiguration }[] } {
    const calls: { payload: TicketPrintPayload; config: PrinterConfiguration }[] = [];
    const driver: IPrinterDriver = {
      async print(payload, config) {
        calls.push({ payload, config });
      },
    };
    return { driver, calls };
  }

  /** A fake driver that rejects on `print` (simulates a TCP failure). */
  function failingDriver(message: string): IPrinterDriver {
    return {
      async print() {
        throw new Error(message);
      },
    };
  }

  function seedConfig(
    repo: ISystemConfigurationRepository,
    printer: PrinterConfiguration,
  ): void {
    // Borrow the default VOs from a fresh `create()` so the reconstitute call
    // only varies the printer config under test.
    const d = SystemConfiguration.create(Identifier.generate());
    const config = SystemConfiguration.reconstitute({
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
      printerConfiguration: printer,
    });
    void repo.save(config);
  }

  const payload: TicketPrintPayload = {
    ticketNumber: 'A-001',
    categoryName: 'Customer Service',
    storeName: 'Toko Cetak',
    issuedAt: 1_700_000_000_000,
    waitingAhead: 3,
  };

  it('calls driver.print with the payload + persisted printer config (network-escpos)', async () => {
    const repo = new InMemorySystemConfigurationRepository();
    const printer = PrinterConfiguration.of({ mode: 'network-escpos', host: '192.168.1.50', port: 9100, paperWidth: 80, cutMode: 'full' });
    seedConfig(repo, printer);
    const { driver, calls } = fakeDriver();
    const useCase = new PrintTicketUseCase(repo, driver);

    await useCase.execute(payload);

    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual(payload);
    expect(calls[0].config).toBe(printer);
  });

  it('throws PrinterNotNetworkException when mode is chrome (409 PRINTER_NOT_NETWORK)', async () => {
    const repo = new InMemorySystemConfigurationRepository();
    seedConfig(repo, PrinterConfiguration.of({ mode: 'chrome' }));
    const { driver, calls } = fakeDriver();
    const useCase = new PrintTicketUseCase(repo, driver);

    await expect(useCase.execute(payload)).rejects.toThrow(PrinterNotNetworkException);
    expect(calls).toHaveLength(0);
  });

  it('throws SystemNotConfiguredException when no config exists (clean store)', async () => {
    const repo = new InMemorySystemConfigurationRepository();
    const { driver, calls } = fakeDriver();
    const useCase = new PrintTicketUseCase(repo, driver);

    await expect(useCase.execute(payload)).rejects.toThrow(SystemNotConfiguredException);
    expect(calls).toHaveLength(0);
  });

  it('propagates a driver failure (TCP error) so the controller maps it to 502', async () => {
    const repo = new InMemorySystemConfigurationRepository();
    seedConfig(repo, PrinterConfiguration.of({ mode: 'network-escpos', host: '10.0.0.1' }));
    const useCase = new PrintTicketUseCase(repo, failingDriver('printer connect timeout'));

    await expect(useCase.execute(payload)).rejects.toThrow('printer connect timeout');
  });

  it('throws InvalidArgumentException when no driver is wired (null driver)', async () => {
    const repo = new InMemorySystemConfigurationRepository();
    seedConfig(repo, PrinterConfiguration.of({ mode: 'network-escpos', host: '10.0.0.1' }));
    const useCase = new PrintTicketUseCase(repo, null);

    await expect(useCase.execute(payload)).rejects.toThrow(InvalidArgumentException);
  });

  it('uses the persisted paperWidth + cutMode on the driver call (config flows through)', async () => {
    const repo = new InMemorySystemConfigurationRepository();
    const printer = PrinterConfiguration.of({ mode: 'network-escpos', host: 'h', paperWidth: 58, cutMode: 'none' });
    seedConfig(repo, printer);
    const { driver, calls } = fakeDriver();
    const useCase = new PrintTicketUseCase(repo, driver);

    await useCase.execute(payload);

    expect(calls[0].config.paperWidth).toBe(58);
    expect(calls[0].config.cutMode).toBe('none');
  });
});

// Reference the token so the import is not tree-shaken / flagged unused in
// strict linters — the fake driver satisfies the interface structurally.
void PRINTER_DRIVER;