import { Identifier } from '../../../src/domain/shared';
import {
  InvalidStateTransitionException,
  SystemNotConfiguredException,
} from '../../../src/domain/shared/errors';
import { TicketStatus } from '../../../src/domain/queue';
import {
  BrandColor,
  ServiceThemes,
  TvDisplayOptions,
  StateMachine,
  StateSchema,
  StateTransitionRule,
  SystemConfiguration,
} from '../../../src/domain/store-config';
import { InMemorySystemConfigurationRepository } from '../../../src/infrastructure/persistence/in-memory';
import { StateTransitionValidator } from '../../../src/interface-adapters/config/state-transition.validator';

describe('StateTransitionValidator (active-policy resolver — QUE-10 AC#1)', () => {
  let config: InMemorySystemConfigurationRepository;
  let validator: StateTransitionValidator;

  beforeEach(() => {
    config = new InMemorySystemConfigurationRepository();
    validator = new StateTransitionValidator(config);
  });

  it('reads the active state machine from the persisted SystemConfiguration', async () => {
    const system = SystemConfiguration.create(Identifier.generate(), 'Toko Utama');
    await config.save(system);

    const policy = await validator.getActivePolicy();

    // The active policy is the configured state machine; the default machine's
    // edges are readable through it (AC#1 — validator reads active config).
    expect(policy).toBe(system.stateMachine);
    expect(policy.isAllowed(TicketStatus.WAITING, TicketStatus.CALLING)).toBe(true);
    expect(policy.actionLabelFor(TicketStatus.WAITING, TicketStatus.CALLING)).toBe(
      'Panggil Berikutnya',
    );
  });

  it('throws SystemNotConfiguredException when no configuration exists yet', async () => {
    await expect(validator.getActivePolicy()).rejects.toBeInstanceOf(
      SystemNotConfiguredException,
    );
  });

  it('assertAllowed passes for a legal transition', async () => {
    await config.save(SystemConfiguration.create(Identifier.generate(), 'Toko Utama'));
    await expect(
      validator.assertAllowed(TicketStatus.WAITING, TicketStatus.CALLING),
    ).resolves.toBeUndefined();
  });

  it('assertAllowed throws InvalidStateTransitionException for an illegal transition', async () => {
    await config.save(SystemConfiguration.create(Identifier.generate(), 'Toko Utama'));
    // Default machine has no WAITING -> SERVING edge.
    await expect(
      validator.assertAllowed(TicketStatus.WAITING, TicketStatus.SERVING),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
  });

  it('assertAllowed propagates SystemNotConfiguredException when unconfigured', async () => {
    await expect(
      validator.assertAllowed(TicketStatus.WAITING, TicketStatus.CALLING),
    ).rejects.toBeInstanceOf(SystemNotConfiguredException);
  });

  it('reflects a reconfigured state machine: a custom CALLING -> WAITING edge becomes allowed', async () => {
    // The wizard/admin enables transfers by configuring a machine with a
    // CALLING -> WAITING edge. `stateMachine` is readonly on the aggregate, so
    // reconstitute a configured instance — the validator must read THIS active
    // machine, not the default.
    const transferMachine = new StateMachine(
      StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED']),
      [
        ['WAITING', 'CALLING', 'Panggil Berikutnya'],
        ['CALLING', 'SERVING', 'Mulai Melayani'],
        ['CALLING', 'SKIPPED', 'Lewati / Absen'],
        ['SKIPPED', 'CALLING', 'Panggil Ulang'],
        ['SERVING', 'COMPLETED', 'Selesai Layan'],
        ['CALLING', 'WAITING', 'Pindah Kategori'],
      ].map(([from, to, actionLabel]) =>
        StateTransitionRule.of(from, to, actionLabel),
      ),
    );
    const system = SystemConfiguration.reconstitute({
      id: Identifier.generate(),
      storeName: 'Toko Utama',
      isInitialSetupCompleted: true,
      stateMachine: transferMachine,
      dailyResetPolicy: SystemConfiguration.create(Identifier.generate()).dailyResetPolicy,
      brandColor: BrandColor.DEFAULT,
      serviceThemes: ServiceThemes.DEFAULT,
      tvDisplayOptions: TvDisplayOptions.DEFAULT,
    });
    await config.save(system);

    const policy = await validator.getActivePolicy();
    expect(policy).toBe(transferMachine);
    expect(policy.isAllowed(TicketStatus.CALLING, TicketStatus.WAITING)).toBe(true);
    expect(policy.actionLabelFor(TicketStatus.CALLING, TicketStatus.WAITING)).toBe(
      'Pindah Kategori',
    );
  });
});