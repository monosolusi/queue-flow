import {
  SaveSystemConfigurationUseCase,
  projectStateMachine,
  type SaveSystemConfigurationCommand,
} from '../../src/application/store-config';
import {
  StateMachine,
  DailyResetMode,
  SystemConfigurationChangedEvent,
  EdgeRoutingLayout,
  NodeActions,
  NodePositions,
  PrinterConfiguration,
  StateDescriptions,
} from '../../src/domain/store-config';
import type { DomainEvent } from '../../src/domain/shared/domain-event';
import type { IEventDispatcher } from '../../src/domain/shared/event-dispatcher.port';
import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import { PriorityPolicy, NoOpTransactionManager } from '../../src/domain/shared';
import {
  InMemoryCategoryRepository,
  InMemoryCounterRoutingRuleRepository,
  InMemorySystemConfigurationRepository,
} from '../../src/infrastructure/persistence/in-memory';

const CAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAT_B = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';

/**
 * Regression guard for the category id-preservation contract QUE-24's admin
 * panel depends on. `QueueTicket.categoryId` stores the category's UUID, and
 * the admin panel edits categories post-setup (while tickets exist). If the
 * save use case regenerated ids on every save, a re-edit would orphan every
 * existing ticket's `categoryId`. The use case reuses a provided `id`
 * (`Identifier.of`) and only mints one when `id` is absent — this spec locks
 * that behavior. Constructed directly with the in-memory ports + the no-op
 * transaction manager (dev/test default) and no audit use case; the contract
 * is pure to the category repository, independent of tx/audit wiring.
 */
describe('SaveSystemConfigurationUseCase — category id preservation (QUE-24)', () => {
  function buildUseCase() {
    return {
      config: new InMemorySystemConfigurationRepository(),
      categories: new InMemoryCategoryRepository(),
      routingRules: new InMemoryCounterRoutingRuleRepository(),
    };
  }

  function baseCommand(categories: { id?: string; code: string; name: string }[]): SaveSystemConfigurationCommand {
    return {
      storeName: 'Toko Contoh',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset: {
        mode: DailyResetMode.AUTOMATIC_CRON,
        cronExpression: '0 0 * * *',
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories,
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: categories.map((c) => c.code),
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvPanelLayout: [
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
        { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
        { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
      ],
      edgeRoutingLayout: {},
      nodePositions: {},
      nodeActions: {},
      terminalNodes: { start: 'auto', end: 'auto' },
      printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
      actor: 'admin',
    };
  }

  it('reuses the provided category id when the payload carries one', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await useCase.execute(
      baseCommand([
        { id: CAT_A, code: 'A', name: 'Customer Service' },
        { id: CAT_B, code: 'B', name: 'Farmasi' },
      ]),
    );

    expect((await repos.categories.getById(CAT_A))?.code).toBe('A');
    expect((await repos.categories.getById(CAT_B))?.code).toBe('B');
  });

  it('mints a new id when the payload omits id', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await useCase.execute(baseCommand([{ code: 'A', name: 'Customer Service' }]));

    const saved = await repos.categories.getAll();
    expect(saved).toHaveLength(1);
    expect(saved[0].id.value).toBeTruthy();
    // A freshly minted Identifier is a non-empty string, not the literal code.
    expect(saved[0].id.value).not.toBe('A');
  });

  it('re-saving with the same ids keeps category ids stable (existing tickets stay valid)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await useCase.execute(
      baseCommand([
        { id: CAT_A, code: 'A', name: 'Customer Service' },
        { id: CAT_B, code: 'B', name: 'Farmasi' },
      ]),
    );
    const idA = (await repos.categories.getById(CAT_A))!.id.value;

    // The manager re-edits — e.g. renames category A — and re-saves carrying
    // the same ids (as the admin panel does). The id must not change.
    await useCase.execute(
      baseCommand([
        { id: CAT_A, code: 'A', name: 'Loket 1' },
        { id: CAT_B, code: 'B', name: 'Farmasi' },
      ]),
    );

    expect((await repos.categories.getById(CAT_A))?.name).toBe('Loket 1');
    expect((await repos.categories.getById(CAT_A))?.id.value).toBe(idA);
  });
});

/**
 * Brand-color persistence (QUE-36). `brandColor` is a required field on the
 * save command; the use case validates it pre-tx (fail-fast — a malformed color
 * never acquires a transaction) and the persisted aggregate carries it through.
 * The result echoes the stored brand color back to the caller.
 */
describe('SaveSystemConfigurationUseCase — brandColor (QUE-36)', () => {
  function buildUseCase() {
    return {
      config: new InMemorySystemConfigurationRepository(),
      categories: new InMemoryCategoryRepository(),
      routingRules: new InMemoryCounterRoutingRuleRepository(),
    };
  }

  function command(brandColor: string): SaveSystemConfigurationCommand {
    return {
      storeName: 'Toko Brand',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset: {
        mode: DailyResetMode.MANUAL,
        cronExpression: null,
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories: [{ code: 'A', name: 'Customer Service' }],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor,
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvPanelLayout: [
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
        { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
        { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
      ],
      edgeRoutingLayout: {},
      nodePositions: {},
      nodeActions: {},
      terminalNodes: { start: 'auto', end: 'auto' },
      printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
      actor: 'admin',
    };
  }

  it('persists a custom brand color and echoes it in the result', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const result = await useCase.execute(command('#aabbcc'));

    expect(result.brandColor).toBe('#aabbcc');
    const saved = await repos.config.get();
    expect(saved!.brandColor.value).toBe('#aabbcc');
  });

  it('rejects a malformed brand color pre-tx with InvalidValueObjectException', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await expect(useCase.execute(command('not-a-color'))).rejects.toThrow(
      InvalidValueObjectException,
    );
    // Nothing persisted — fail-fast happened before the tx opened.
    expect(await repos.config.get()).toBeNull();
  });

  it('rejects an overlapping tvPanelLayout pre-tx with InvalidValueObjectException (NFR-REL-02)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    // Two widgets whose rectangles share cells — the VO's overlap invariant
    // must reject this before the tx opens (fail-fast, no illegal layout burns
    // a write).
    const overlapping: SaveSystemConfigurationCommand = {
      ...command('#2563eb'),
      tvPanelLayout: [
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'w2', component: 'waitingQueue', x: 0, y: 0, w: 6, h: 4 },
      ],
    };

    await expect(useCase.execute(overlapping)).rejects.toThrow(
      InvalidValueObjectException,
    );
    // Nothing persisted — fail-fast happened before the tx opened.
    expect(await repos.config.get()).toBeNull();
  });
});

/**
 * FR-CLR-02 — a save broadcasts `SYSTEM_CONFIG_CHANGED` post-commit so a
 * connected caller panel refetches the active state machine and reflects the
 * admin-designed flow + its `actionLabel` wording without a page reload. The
 * dispatcher is a shared-kernel port ({@link IEventDispatcher}); this spec
 * injects a recording fake of that port (not the Queue-owned concrete
 * `QueueEventDispatcher`) to pin that the use case depends only on the
 * abstraction (DIP / bounded-context anti-corruption) and emits exactly one
 * {@link SystemConfigurationChangedEvent} after a successful save, and nothing
 * at all on a rolled-back (pre-tx validation) save.
 */
describe('SaveSystemConfigurationUseCase — SYSTEM_CONFIG_CHANGED broadcast (FR-CLR-02)', () => {
  /** A recording fake of the {@link IEventDispatcher} port the use case drains
   *  into. Depends only on the shared-kernel port, never on the Queue-owned
   *  concrete dispatcher — mirrors how the use case itself is wired (DIP). */
  function recordingDispatcher() {
    const published: DomainEvent[] = [];
    const dispatcher: IEventDispatcher = {
      async dispatchEvents(events: readonly DomainEvent[]): Promise<void> {
        published.push(...events);
      },
    };
    return { dispatcher, published };
  }

  function baseCommand(): SaveSystemConfigurationCommand {
    return {
      storeName: 'Toko Contoh',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset: {
        mode: DailyResetMode.MANUAL,
        cronExpression: null,
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories: [{ code: 'A', name: 'Customer Service' }],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvPanelLayout: [
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
        { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
        { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
      ],
      edgeRoutingLayout: {},
      nodePositions: {},
      nodeActions: {},
      terminalNodes: { start: 'auto', end: 'auto' },
      printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
      actor: 'admin',
    };
  }

  it('broadcasts one SystemConfigurationChangedEvent after a successful save', async () => {
    const config = new InMemorySystemConfigurationRepository();
    const categories = new InMemoryCategoryRepository();
    const routingRules = new InMemoryCounterRoutingRuleRepository();
    const { dispatcher, published } = recordingDispatcher();
    const useCase = new SaveSystemConfigurationUseCase(
      config,
      categories,
      routingRules,
      new NoOpTransactionManager(),
      null,
      null,
      dispatcher,
    );

    await useCase.execute(baseCommand());

    expect(published).toHaveLength(1);
    expect(published[0]).toBeInstanceOf(SystemConfigurationChangedEvent);
    expect(published[0].type).toBe('SYSTEM_CONFIG_CHANGED');
  });

  it('broadcasts nothing when the dispatcher is not wired (unit-test default)', async () => {
    // The dispatcher is optional — construction with the three repository
    // ports alone (audit/scheduler/dispatcher null) must not throw and must
    // still persist (the broadcast is not on the critical save path).
    const useCase = new SaveSystemConfigurationUseCase(
      new InMemorySystemConfigurationRepository(),
      new InMemoryCategoryRepository(),
      new InMemoryCounterRoutingRuleRepository(),
      new NoOpTransactionManager(),
    );

    await expect(useCase.execute(baseCommand())).resolves.toMatchObject({
      storeName: 'Toko Contoh',
      brandColor: '#2563eb',
    });
  });

  it('broadcasts nothing on a pre-tx validation failure (no announce of an un-persisted config)', async () => {
    const { dispatcher, published } = recordingDispatcher();
    const useCase = new SaveSystemConfigurationUseCase(
      new InMemorySystemConfigurationRepository(),
      new InMemoryCategoryRepository(),
      new InMemoryCounterRoutingRuleRepository(),
      new NoOpTransactionManager(),
      null,
      null,
      dispatcher,
    );

    await expect(useCase.execute({ ...baseCommand(), brandColor: 'not-a-color' })).rejects.toThrow(
      InvalidValueObjectException,
    );
    // Post-commit broadcast never fires — the save rolled back pre-tx (NFR-REL-02).
    expect(published).toHaveLength(0);
  });
});

/**
 * Edge routing layout persistence (per-edge connection-point map for the admin
 * state-machine visual editor). `edgeRoutingLayout` is a required field on the
 * save command; the use case validates it pre-tx (fail-fast — a malformed map
 * never acquires a transaction), performs the edge-membership cross-check
 * (anti-corruption: the VO stays free of a StateMachine dependency), and the
 * persisted aggregate carries it through. The result echoes the stored map
 * back to the caller.
 */
describe('SaveSystemConfigurationUseCase — edgeRoutingLayout', () => {
  function buildUseCase() {
    return {
      config: new InMemorySystemConfigurationRepository(),
      categories: new InMemoryCategoryRepository(),
      routingRules: new InMemoryCounterRoutingRuleRepository(),
    };
  }

  function command(edgeRoutingLayout: Record<string, { sourceSide: string; targetSide: string }>): SaveSystemConfigurationCommand {
    return {
      storeName: 'Toko Brand',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset: {
        mode: DailyResetMode.MANUAL,
        cronExpression: null,
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories: [{ code: 'A', name: 'Customer Service' }],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvPanelLayout: [
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
        { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
        { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
      ],
      edgeRoutingLayout: edgeRoutingLayout as SaveSystemConfigurationCommand['edgeRoutingLayout'],
      nodePositions: {},
      nodeActions: {},
      terminalNodes: { start: 'auto', end: 'auto' },
      printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
      actor: 'admin',
    };
  }

  it('persists a non-empty edgeRoutingLayout and echoes it in the result', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const layout = { 'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' } };
    const result = await useCase.execute(command(layout));

    expect(result.edgeRoutingLayout).toEqual(layout);
    const saved = await repos.config.get();
    expect(saved!.edgeRoutingLayout.toDto()).toEqual(layout);
  });

  it('round-trips a re-GET via the aggregate (sparse map preserved)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const layout = {
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
      'WAITING->CALLING': { sourceSide: 'top', targetSide: 'bottom' },
    };
    await useCase.execute(command(layout));

    const saved = await repos.config.get();
    expect(saved!.edgeRoutingLayout.toDto()).toEqual(layout);
  });

  it('rejects a layout key that is not a transition in the active state machine (cross-check, NFR-REL-02)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    // WAITING->COMPLETED is not an edge in the default state machine — the
    // cross-check must throw InvalidValueObjectException pre-tx.
    await expect(
      useCase.execute(command({ 'WAITING->COMPLETED': { sourceSide: 'top', targetSide: 'bottom' } })),
    ).rejects.toThrow(InvalidValueObjectException);
    // Nothing persisted — fail-fast happened before the tx opened.
    expect(await repos.config.get()).toBeNull();
  });

  it('rejects an invalid side enum pre-tx with InvalidValueObjectException (VO of())', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await expect(
      useCase.execute(
        command({ 'SKIPPED->CALLING': { sourceSide: 'sideways', targetSide: 'top' } }),
      ),
    ).rejects.toThrow(InvalidValueObjectException);
    expect(await repos.config.get()).toBeNull();
  });

  it('accepts an empty edgeRoutingLayout (all-default routing)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const result = await useCase.execute(command({}));
    expect(result.edgeRoutingLayout).toEqual({});
    const saved = await repos.config.get();
    expect(saved!.edgeRoutingLayout.toDto()).toEqual({});
    expect(saved!.edgeRoutingLayout.equals(EdgeRoutingLayout.DEFAULT)).toBe(true);
  });
});

/**
 * Node positions persistence (per-state x/y map for the admin state-machine
 * visual editor). `nodePositions` is a required field on the save command; the
 * use case validates it pre-tx (fail-fast — a malformed map never acquires a
 * transaction), performs the state-membership cross-check (anti-corruption:
 * the VO stays free of a StateMachine dependency), and the persisted aggregate
 * carries it through. The result echoes the stored map back to the caller. The
 * cross-check is against the state-schema STATES (not transition edges — that's
 * `edgeRoutingLayout`'s check).
 */
describe('SaveSystemConfigurationUseCase — nodePositions', () => {
  function buildUseCase() {
    return {
      config: new InMemorySystemConfigurationRepository(),
      categories: new InMemoryCategoryRepository(),
      routingRules: new InMemoryCounterRoutingRuleRepository(),
    };
  }

  function command(nodePositions: Record<string, { x: number; y: number }>): SaveSystemConfigurationCommand {
    return {
      storeName: 'Toko Brand',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset: {
        mode: DailyResetMode.MANUAL,
        cronExpression: null,
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories: [{ code: 'A', name: 'Customer Service' }],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvPanelLayout: [
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
        { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
        { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
      ],
      edgeRoutingLayout: {},
      nodePositions: nodePositions as SaveSystemConfigurationCommand['nodePositions'],
      nodeActions: {},
      terminalNodes: { start: 'auto', end: 'auto' },
      printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
      actor: 'admin',
    };
  }

  it('persists a non-empty nodePositions and echoes it in the result', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const positions = { WAITING: { x: 0, y: 0 }, CALLING: { x: 240, y: 0 } };
    const result = await useCase.execute(command(positions));

    expect(result.nodePositions).toEqual(positions);
    const saved = await repos.config.get();
    expect(saved!.nodePositions.toDto()).toEqual(positions);
  });

  it('round-trips a re-GET via the aggregate (positions preserved)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const positions = { WAITING: { x: 0, y: 0 }, CALLING: { x: 240, y: 0 } };
    await useCase.execute(command(positions));

    const saved = await repos.config.get();
    expect(saved!.nodePositions.toDto()).toEqual(positions);
  });

  it('rejects a nodePositions key that is not a state in the active state machine (cross-check, NFR-REL-02)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    // NOPE is not a state in the default state machine — the cross-check must
    // throw InvalidValueObjectException pre-tx.
    await expect(useCase.execute(command({ NOPE: { x: 0, y: 0 } }))).rejects.toThrow(
      InvalidValueObjectException,
    );
    // Nothing persisted — fail-fast happened before the tx opened.
    expect(await repos.config.get()).toBeNull();
  });

  it('rejects a non-finite x pre-tx with InvalidValueObjectException (VO of())', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await expect(
      useCase.execute(command({ WAITING: { x: NaN, y: 0 } })),
    ).rejects.toThrow(InvalidValueObjectException);
    expect(await repos.config.get()).toBeNull();
  });

  it('accepts an empty nodePositions (autoLayout)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const result = await useCase.execute(command({}));
    expect(result.nodePositions).toEqual({});
    const saved = await repos.config.get();
    expect(saved!.nodePositions.toDto()).toEqual({});
    expect(saved!.nodePositions.equals(NodePositions.DEFAULT)).toBe(true);
  });
});

/**
 * Printer configuration persistence (which printer the kiosk uses — Chrome's
 * default dialog, or a network ESC/POS printer proxied through core-api).
 * `printerConfiguration` is a required field on the save command; the use case
 * validates it pre-tx (fail-fast — a malformed config never acquires a
 * transaction), and the persisted aggregate carries it through the in-memory
 * repo round-trip. The result echoes the stored config back to the caller.
 */
describe('SaveSystemConfigurationUseCase — printerConfiguration', () => {
  function buildUseCase() {
    return {
      config: new InMemorySystemConfigurationRepository(),
      categories: new InMemoryCategoryRepository(),
      routingRules: new InMemoryCounterRoutingRuleRepository(),
    };
  }

  function command(printer: Record<string, unknown>): SaveSystemConfigurationCommand {
    return {
      storeName: 'Toko Cetak',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset: {
        mode: DailyResetMode.MANUAL,
        cronExpression: null,
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories: [{ code: 'A', name: 'Customer Service' }],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvPanelLayout: [
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
        { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
        { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
      ],
      edgeRoutingLayout: {},
      nodePositions: {},
      nodeActions: {},
      terminalNodes: { start: 'auto', end: 'auto' },
      printerConfiguration: printer as unknown as SaveSystemConfigurationCommand['printerConfiguration'],
      actor: 'admin',
    };
  }

  it('persists a network-escpos printer config and echoes it in the result', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const printer = { mode: 'network-escpos', paperWidth: 58, host: '192.168.1.50', port: 9100, cutMode: 'full', baudRate: 19200 };
    const result = await useCase.execute(command(printer));

    expect(result.printerConfiguration).toEqual(printer);
    const saved = await repos.config.get();
    expect(saved!.printerConfiguration.toDto()).toEqual(printer);
    expect(saved!.printerConfiguration.equals(PrinterConfiguration.of(printer))).toBe(true);
  });

  it('round-trips the default chrome config through the in-memory repo', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await useCase.execute(command({ mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial' }));

    const saved = await repos.config.get();
    expect(saved!.printerConfiguration.toDto()).toEqual({
      mode: 'chrome',
      paperWidth: 80,
      host: '',
      port: 9100,
      cutMode: 'partial',
      baudRate: 9600,
    });
    expect(saved!.printerConfiguration.equals(PrinterConfiguration.DEFAULT)).toBe(true);
  });

  it('rejects a network-escpos config with no host pre-tx (VO cross-field invariant, NFR-REL-02)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await expect(
      useCase.execute(command({ mode: 'network-escpos', paperWidth: 80, host: '', port: 9100, cutMode: 'partial' })),
    ).rejects.toThrow(InvalidValueObjectException);
    // Nothing persisted — fail-fast happened before the tx opened.
    expect(await repos.config.get()).toBeNull();
  });
});

/**
 * Node actions persistence (per-state Kaleo-style node-level action map for the
 * admin state-machine editor). `nodeActions` is a required field on the save
 * command; the use case validates it pre-tx (fail-fast — a malformed map never
 * acquires a transaction), performs the state-membership + value-membership
 * cross-check (anti-corruption: the VO stays free of a StateMachine
 * dependency), and the persisted aggregate carries it through. The result
 * echoes the stored map back to the caller. The cross-check is against the
 * state-schema STATES (both the action-map key AND an `UPDATE_STATUS` action's
 * `value` must be a state — the latter is the Kaleo "Update Status → X" target).
 */
describe('SaveSystemConfigurationUseCase — nodeActions', () => {
  function buildUseCase() {
    return {
      config: new InMemorySystemConfigurationRepository(),
      categories: new InMemoryCategoryRepository(),
      routingRules: new InMemoryCounterRoutingRuleRepository(),
    };
  }

  function command(nodeActions: Record<string, unknown>): SaveSystemConfigurationCommand {
    return {
      storeName: 'Toko Brand',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset: {
        mode: DailyResetMode.MANUAL,
        cronExpression: null,
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories: [{ code: 'A', name: 'Customer Service' }],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvPanelLayout: [
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
        { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
        { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
      ],
      edgeRoutingLayout: {},
      nodePositions: {},
      nodeActions: nodeActions as SaveSystemConfigurationCommand['nodeActions'],
      terminalNodes: { start: 'auto', end: 'auto' },
      printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
      actor: 'admin',
    };
  }

  it('persists a non-empty nodeActions and echoes it in the result', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const actions = {
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
      CALLING: [{ executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' }],
    };
    const result = await useCase.execute(command(actions));

    expect(result.nodeActions).toEqual(actions);
    const saved = await repos.config.get();
    expect(saved!.nodeActions.toDto()).toEqual(actions);
  });

  it('round-trips a re-GET via the aggregate (actions preserved)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const actions = {
      WAITING: [
        { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' },
        { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'SERVING' },
      ],
    };
    await useCase.execute(command(actions));

    const saved = await repos.config.get();
    expect(saved!.nodeActions.toDto()).toEqual(actions);
  });

  it('rejects a nodeActions key that is not a state in the active state machine (cross-check, NFR-REL-02)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    // NOPE is not a state in the default state machine — the cross-check must
    // throw InvalidValueObjectException pre-tx.
    await expect(
      useCase.execute(
        command({ NOPE: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }] }),
      ),
    ).rejects.toThrow(InvalidValueObjectException);
    // Nothing persisted — fail-fast happened before the tx opened.
    expect(await repos.config.get()).toBeNull();
  });

  it('rejects an UPDATE_STATUS value that is not a state in the active state machine (cross-check, NFR-REL-02)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    // WAITING is a real state, but the action target ALSO_NOPE is not — the
    // value-membership cross-check must throw InvalidValueObjectException pre-tx.
    await expect(
      useCase.execute(
        command({ WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'ALSO_NOPE' }] }),
      ),
    ).rejects.toThrow(InvalidValueObjectException);
    expect(await repos.config.get()).toBeNull();
  });

  it('rejects a non-array entry value pre-tx with InvalidValueObjectException (VO of())', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await expect(
      useCase.execute(command({ WAITING: 'not-an-array' })),
    ).rejects.toThrow(InvalidValueObjectException);
    expect(await repos.config.get()).toBeNull();
  });

  it('accepts an empty nodeActions (no node-level actions)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const result = await useCase.execute(command({}));
    expect(result.nodeActions).toEqual({});
    const saved = await repos.config.get();
    expect(saved!.nodeActions.toDto()).toEqual({});
    expect(saved!.nodeActions.equals(NodeActions.DEFAULT)).toBe(true);
  });
});

/**
 * Per-state editable descriptions (intrinsic per-state metadata, part of the
 * state-machine definition). Travels INSIDE the `stateMachine` object
 * (`WizardStateMachineDto.descriptions`), so the command's `stateMachine`
 * field carries it — NOT a top-level command field. The save use case builds
 * the `StateDescriptions` VO from `dto.descriptions` and cross-checks each key
 * against the active state machine's states (mirrors the `nodeActions` /
 * `nodePositions` cross-checks). Not audited (mirrors `nodePositions`/
 * `nodeActions`).
 */
describe('SaveSystemConfigurationUseCase — stateMachine.descriptions', () => {
  function buildUseCase() {
    return {
      config: new InMemorySystemConfigurationRepository(),
      categories: new InMemoryCategoryRepository(),
      routingRules: new InMemoryCounterRoutingRuleRepository(),
    };
  }

  function command(descriptions: Record<string, string>): SaveSystemConfigurationCommand {
    const sm = projectStateMachine(StateMachine.DEFAULT);
    return {
      storeName: 'Toko Brand',
      stateMachine: { ...sm, descriptions },
      dailyReset: {
        mode: DailyResetMode.MANUAL,
        cronExpression: null,
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories: [{ code: 'A', name: 'Customer Service' }],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvPanelLayout: [
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
        { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
        { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
      ],
      edgeRoutingLayout: {},
      nodePositions: {},
      nodeActions: {},
      terminalNodes: { start: 'auto', end: 'auto' },
      printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
      actor: 'admin',
    };
  }

  it('persists a non-empty descriptions map and the aggregate carries it', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const descriptions = {
      WAITING: 'Tiket menunggu dipanggil',
      CALLING: 'Sedang dipanggil ke counter',
    };
    await useCase.execute(command(descriptions));

    const saved = await repos.config.get();
    expect(saved!.stateMachine.stateDescriptions.toDto()).toEqual(descriptions);
    expect(saved!.stateMachine.stateDescriptions.descriptionFor('WAITING')).toBe(
      'Tiket menunggu dipanggil',
    );
  });

  it('round-trips a re-GET via the aggregate (descriptions preserved)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const descriptions = { WAITING: 'Tiket menunggu', SERVING: 'Sedang dilayani' };
    await useCase.execute(command(descriptions));

    const saved = await repos.config.get();
    expect(saved!.stateMachine.stateDescriptions.toDto()).toEqual(descriptions);
  });

  it('rejects a descriptions key that is not a state in the active state machine (cross-check, NFR-REL-02)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    // NOPE is not a state in the default state machine — the cross-check must
    // throw InvalidValueObjectException pre-tx.
    await expect(
      useCase.execute(command({ NOPE: 'A description for a non-state' })),
    ).rejects.toThrow(InvalidValueObjectException);
    // Nothing persisted — fail-fast happened before the tx opened.
    expect(await repos.config.get()).toBeNull();
  });

  it('accepts an empty descriptions map (no per-state overrides; derive from canonical copy)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await useCase.execute(command({}));
    const saved = await repos.config.get();
    expect(saved!.stateMachine.stateDescriptions.toDto()).toEqual({});
    expect(saved!.stateMachine.stateDescriptions.equals(StateDescriptions.DEFAULT)).toBe(true);
  });

  it('DROPS empty/whitespace values (a cleared field round-trips as an absent key)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await useCase.execute(
      command({ WAITING: 'Tiket menunggu', CALLING: '   ', SERVING: '' }),
    );
    const saved = await repos.config.get();
    expect(saved!.stateMachine.stateDescriptions.toDto()).toEqual({ WAITING: 'Tiket menunggu' });
  });

  it('backward-compat: an absent descriptions key (undefined) recovers to the empty default', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    // A direct API call / legacy test that omits `descriptions` from the
    // stateMachine payload — the VO recovers `undefined` to DEFAULT.
    const sm = projectStateMachine(StateMachine.DEFAULT);
    const { descriptions: _omit, ...smWithoutDescriptions } = sm;
    void _omit;
    const cmd: SaveSystemConfigurationCommand = {
      ...command({}),
      stateMachine: smWithoutDescriptions,
    };
    await useCase.execute(cmd);
    const saved = await repos.config.get();
    expect(saved!.stateMachine.stateDescriptions.toDto()).toEqual({});
  });
});

/**
 * Terminal nodes persistence (Start/End marker presence + position for the
 * admin state-machine editor). `terminalNodes` is a required field on the save
 * command; the use case validates it pre-tx (fail-fast — a malformed map never
 * acquires a transaction). NO state-membership cross-check is performed —
 * terminal ids `__start`/`__end` are not state names (the whole reason this is
 * a dedicated field, unlike `nodePositions`/`nodeActions`). The result echoes
 * the stored map back to the caller.
 */
describe('SaveSystemConfigurationUseCase — terminalNodes', () => {
  function buildUseCase() {
    return {
      config: new InMemorySystemConfigurationRepository(),
      categories: new InMemoryCategoryRepository(),
      routingRules: new InMemoryCounterRoutingRuleRepository(),
    };
  }

  function command(terminalNodes: unknown): SaveSystemConfigurationCommand {
    return {
      storeName: 'Toko Terminal',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset: {
        mode: DailyResetMode.MANUAL,
        cronExpression: null,
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories: [{ code: 'A', name: 'Customer Service' }],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvPanelLayout: [
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
        { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
        { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
      ],
      edgeRoutingLayout: {},
      nodePositions: {},
      nodeActions: {},
      terminalNodes: terminalNodes as SaveSystemConfigurationCommand['terminalNodes'],
      printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
      actor: 'admin',
    };
  }

  it('round-trips a hidden start + pinned end through save and re-GET via the aggregate', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const tn = { start: 'hidden', end: { x: 320, y: 240 } };
    const result = await useCase.execute(command(tn));
    expect(result.terminalNodes).toEqual(tn);

    const saved = await repos.config.get();
    expect(saved!.terminalNodes.toDto()).toEqual(tn);
    expect(saved!.terminalNodes.start).toBe('hidden');
    expect(saved!.terminalNodes.end).toEqual({ x: 320, y: 240 });
  });

  it('accepts an auto/auto terminalNodes (default markers)', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    const result = await useCase.execute(command({ start: 'auto', end: 'auto' }));
    expect(result.terminalNodes).toEqual({ start: 'auto', end: 'auto' });
    const saved = await repos.config.get();
    expect(saved!.terminalNodes.toDto()).toEqual({ start: 'auto', end: 'auto' });
  });

  it('rejects a non-object terminalNodes pre-tx with InvalidValueObjectException', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await expect(useCase.execute(command('not-an-object'))).rejects.toThrow(
      InvalidValueObjectException,
    );
    expect(await repos.config.get()).toBeNull();
  });

  it('rejects a non-finite x in a pinned terminal pre-tx with InvalidValueObjectException', async () => {
    const repos = buildUseCase();
    const useCase = new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      null,
    );

    await expect(
      useCase.execute(command({ start: { x: 'bad', y: 0 }, end: 'auto' })),
    ).rejects.toThrow(InvalidValueObjectException);
    expect(await repos.config.get()).toBeNull();
  });
});