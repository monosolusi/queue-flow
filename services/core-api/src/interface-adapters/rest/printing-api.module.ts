import { Module } from '@nestjs/common';
import { PRINTER_DRIVER, SYSTEM_CONFIGURATION_REPOSITORY } from '../../domain/store-config';
import { PrintTicketUseCase } from '../../application/store-config';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { EscPosPrinterDriver } from '../../infrastructure/printing/escpos/escpos-printer-driver';
import { PrintController } from './print.controller';

/**
 * Wires the kiosk print-proxy REST surface (FR-printer-config). The use case is
 * a pure, framework-free class (no `@Injectable`/`@Inject` — consistent with the
 * application layer), so it is provided via a factory that receives the
 * {@link SYSTEM_CONFIGURATION_REPOSITORY} port from {@link PersistenceModule}
 * and the {@link PRINTER_DRIVER} concretion (the {@link EscPosPrinterDriver}).
 *
 * The driver concretion lives in infrastructure (the only layer permitted to
 * import `net`); this module binds it under the domain `PRINTER_DRIVER` Symbol
 * token so the use case depends on the abstraction (DIP), never on the
 * concrete driver. Kept as its own per-concern module (SRP): the print proxy is
 * a distinct concern from the queue command surface, the system-config CRUD
 * surface, and the read-only caller surface. The endpoint is public (no auth
 * guard) — the kiosk is an unattended touchscreen on the store LAN and the
 * ticket is already persisted by `POST /api/tickets`.
 *
 * No `RealtimeModule` import: printing is fire-and-forget best-effort and does
 * not broadcast over the WS gateway (the TV display already learned of the
 * ticket via the `TICKET_CREATED` event from ticket creation).
 */
@Module({
  imports: [PersistenceModule.forRoot()],
  controllers: [PrintController],
  providers: [
    { provide: PRINTER_DRIVER, useClass: EscPosPrinterDriver },
    {
      provide: PrintTicketUseCase,
      inject: [SYSTEM_CONFIGURATION_REPOSITORY, PRINTER_DRIVER],
      useFactory: (config, driver) => new PrintTicketUseCase(config, driver),
    },
  ],
})
export class PrintingApiModule {}