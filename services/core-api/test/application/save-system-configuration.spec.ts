import {
  SaveSystemConfigurationUseCase,
  projectStateMachine,
  type SaveSystemConfigurationCommand,
} from '../../src/application/store-config';
import { StateMachine, DailyResetMode } from '../../src/domain/store-config';
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