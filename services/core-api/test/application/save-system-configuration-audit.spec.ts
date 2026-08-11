import {
  SaveSystemConfigurationUseCase,
  projectStateMachine,
  type SaveSystemConfigurationCommand,
} from '../../src/application/store-config';
import { RecordAuditEntryUseCase } from '../../src/application/audit/record-audit-entry.use-case';
import { StateMachine, DailyResetMode, type IDailyResetSchedulerPort } from '../../src/domain/store-config';
import { PriorityPolicy, NoOpTransactionManager } from '../../src/domain/shared';
import { AuditAction } from '../../src/domain/audit';
import {
  InMemoryAuditLogRepository,
  InMemoryCategoryRepository,
  InMemoryCounterRoutingRuleRepository,
  InMemorySystemConfigurationRepository,
} from '../../src/infrastructure/persistence/in-memory';

const CAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAT_B = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';

/**
 * QUE-32 — the save use case records a `DAILY_RESET_POLICY_CHANGE` audit entry
 * **only when the daily-reset policy actually changed** (or on initial setup),
 * and re-arms the scheduler post-commit in the same situation. Unlike
 * `STATE_SCHEMA_CHANGE` / `ROUTING_CHANGE` (recorded on every save), the policy
 * entry is change-gated, so a categories-only edit records nothing spurious and
 * does not churn the running cron.
 */
describe('SaveSystemConfigurationUseCase — daily-reset policy audit + re-arm (QUE-32)', () => {
  function buildRepos() {
    return {
      config: new InMemorySystemConfigurationRepository(),
      categories: new InMemoryCategoryRepository(),
      routingRules: new InMemoryCounterRoutingRuleRepository(),
      auditLog: new InMemoryAuditLogRepository(),
    };
  }

  /** A fake scheduler port that records `reArm()` calls for assertion. */
  function fakeScheduler(): IDailyResetSchedulerPort & { calls: number } {
    // `reArm` closes over the fake object itself so incrementing `fake.calls`
    // is visible to the test through the same property (a separate `stub`
    // object + Object.assign would copy the number and diverge from the closure).
    const fake = {
      calls: 0,
      reArm: async () => {
        fake.calls += 1;
      },
    };
    return fake as unknown as IDailyResetSchedulerPort & { calls: number };
  }

  function baseCommand(overrides: Partial<SaveSystemConfigurationCommand> = {}): SaveSystemConfigurationCommand {
    return {
      storeName: 'Toko Contoh',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset: {
        mode: DailyResetMode.AUTOMATIC_CRON,
        cronExpression: '0 0 * * *',
        resetTicketNumberTo: 1,
        archivePreviousDayData: true,
      },
      categories: [
        { id: CAT_A, code: 'A', name: 'Customer Service' },
        { id: CAT_B, code: 'B', name: 'Kasir & Pembayaran' },
      ],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A', 'B'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
      tvDisplayOptions: {
        showNowServing: true,
        showWaitingQueue: true,
        showCallHistory: true,
        showCountersServing: true,
        showRunningText: true,
      },
      actor: 'admin',
      ...overrides,
    };
  }

  function buildUseCase(
    repos: ReturnType<typeof buildRepos>,
    scheduler: IDailyResetSchedulerPort | null,
  ) {
    return new SaveSystemConfigurationUseCase(
      repos.config,
      repos.categories,
      repos.routingRules,
      new NoOpTransactionManager(),
      new RecordAuditEntryUseCase(repos.auditLog),
      scheduler,
    );
  }

  async function policyChangeActions(repos: ReturnType<typeof buildRepos>) {
    return (await repos.auditLog.list())
      .filter((e) => e.action === AuditAction.DAILY_RESET_POLICY_CHANGE)
      .map((e) => ({ before: e.before, after: e.after }));
  }

  it('records DAILY_RESET_POLICY_CHANGE with before=null on initial setup and re-arms once', async () => {
    const repos = buildRepos();
    const scheduler = fakeScheduler();
    const useCase = buildUseCase(repos, scheduler);

    await useCase.execute(baseCommand());

    const changes = await policyChangeActions(repos);
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBeNull();
    expect(changes[0].after).toMatchObject({ mode: 'AUTOMATIC_CRON', cronExpression: '0 0 * * *' });
    expect(scheduler.calls).toBe(1);
  });

  it('does NOT record DAILY_RESET_POLICY_CHANGE nor re-arm when the policy is unchanged', async () => {
    const repos = buildRepos();
    const scheduler = fakeScheduler();
    const useCase = buildUseCase(repos, scheduler);

    await useCase.execute(baseCommand());
    // Re-save with the SAME daily-reset policy but a renamed category (a
    // categories-only edit). The policy entry must not be recorded and the
    // cron must not be churned.
    await useCase.execute(
      baseCommand({
        categories: [
          { id: CAT_A, code: 'A', name: 'Loket 1' },
          { id: CAT_B, code: 'B', name: 'Kasir & Pembayaran' },
        ],
      }),
    );

    const changes = await policyChangeActions(repos);
    expect(changes).toHaveLength(1); // only the initial-setup entry
    expect(scheduler.calls).toBe(1); // only the initial-setup re-arm
  });

  it('records DAILY_RESET_POLICY_CHANGE with before/after and re-arms when the cron expression changes', async () => {
    const repos = buildRepos();
    const scheduler = fakeScheduler();
    const useCase = buildUseCase(repos, scheduler);

    await useCase.execute(baseCommand());
    await useCase.execute(
      baseCommand({
        dailyReset: {
          mode: DailyResetMode.AUTOMATIC_CRON,
          cronExpression: '0 1 * * *',
          resetTicketNumberTo: 1,
          archivePreviousDayData: true,
        },
      }),
    );

    const changes = await policyChangeActions(repos);
    expect(changes).toHaveLength(2); // initial setup + the cron edit
    expect(changes[1].before).toMatchObject({ cronExpression: '0 0 * * *' });
    expect(changes[1].after).toMatchObject({ cronExpression: '0 1 * * *' });
    expect(scheduler.calls).toBe(2);
  });

  it('records + re-arms when switching mode to MANUAL', async () => {
    const repos = buildRepos();
    const scheduler = fakeScheduler();
    const useCase = buildUseCase(repos, scheduler);

    await useCase.execute(baseCommand());
    await useCase.execute(
      baseCommand({
        dailyReset: {
          mode: DailyResetMode.MANUAL,
          cronExpression: null,
          resetTicketNumberTo: 1,
          archivePreviousDayData: true,
        },
      }),
    );

    const changes = await policyChangeActions(repos);
    expect(changes).toHaveLength(2);
    expect(changes[1].after).toMatchObject({ mode: 'MANUAL', cronExpression: null });
    expect(scheduler.calls).toBe(2);
  });

  /**
   * QUE-42 — a provided `timezone` round-trips through the saved
   * `DailyResetPolicy.timezone` and appears in the audit `after` snapshot.
   * The before/after `toMatchObject` assertions stay subset-safe (the snapshot
   * now carries `timezone`, but existing assertions that match a subset of
   * fields keep passing).
   */
  it('persists a provided timezone and records it in the audit after snapshot (QUE-42)', async () => {
    const repos = buildRepos();
    const scheduler = fakeScheduler();
    const useCase = buildUseCase(repos, scheduler);

    await useCase.execute(
      baseCommand({
        dailyReset: {
          mode: DailyResetMode.AUTOMATIC_CRON,
          cronExpression: '0 0 * * *',
          resetTicketNumberTo: 1,
          archivePreviousDayData: true,
          timezone: 'Asia/Jakarta',
        },
      }),
    );

    const saved = await repos.config.get();
    expect(saved!.dailyResetPolicy.timezone).toBe('Asia/Jakarta');

    const changes = await policyChangeActions(repos);
    expect(changes).toHaveLength(1);
    expect(changes[0].after).toMatchObject({ timezone: 'Asia/Jakarta' });
    expect(scheduler.calls).toBe(1);
  });

  it('does not call reArm when no scheduler is injected (unit-test default)', async () => {
    const repos = buildRepos();
    const useCase = buildUseCase(repos, null);

    // No scheduler → the audit entry is still recorded (audit is independent of
    // re-arm), but the post-commit re-arm is skipped.
    await useCase.execute(baseCommand());

    const changes = await policyChangeActions(repos);
    expect(changes).toHaveLength(1);
  });

  it('records DAILY_RESET_POLICY_CHANGE when only resetTicketNumberTo or archive flag changes', async () => {
    const repos = buildRepos();
    const scheduler = fakeScheduler();
    const useCase = buildUseCase(repos, scheduler);

    await useCase.execute(baseCommand());
    await useCase.execute(
      baseCommand({
        dailyReset: {
          mode: DailyResetMode.AUTOMATIC_CRON,
          cronExpression: '0 0 * * *',
          resetTicketNumberTo: 100,
          archivePreviousDayData: false,
        },
      }),
    );

    const changes = await policyChangeActions(repos);
    expect(changes).toHaveLength(2);
    expect(changes[1].before).toMatchObject({ resetTicketNumberTo: 1, archivePreviousDayData: true });
    expect(changes[1].after).toMatchObject({ resetTicketNumberTo: 100, archivePreviousDayData: false });
    expect(scheduler.calls).toBe(2);
  });

  /**
   * QUE-36 regression guard: brand color is cosmetic, so it is NOT audited.
   * NFR-SEC-02 scopes audit to manual reset / state-schema / routing / daily-
   * reset-policy; there is no `BRAND_COLOR_CHANGE` audit action and a brand-
   * color-only edit must record nothing spurious on top of the always-on
   * `STATE_SCHEMA_CHANGE` + `ROUTING_CHANGE`. Locks decision 5 (no brand-color
   * audit) so a future change has to make an explicit, reviewable choice.
   */
  it('does NOT record a brand-color audit entry when only the brand color changes', async () => {
    const repos = buildRepos();
    const scheduler = fakeScheduler();
    const useCase = buildUseCase(repos, scheduler);

    await useCase.execute(baseCommand());
    await useCase.execute(baseCommand({ brandColor: '#aabbcc' }));

    const all = await repos.auditLog.list();
    // No audit action names a brand-color change; the only actions recorded
    // are the always-on STATE_SCHEMA_CHANGE + ROUTING_CHANGE (per save) and the
    // single initial-setup DAILY_RESET_POLICY_CHANGE.
    for (const entry of all) {
      expect(entry.action).not.toMatch(/BRAND_COLOR/i);
    }
    const actionTypes = new Set(all.map((e) => e.action));
    expect(actionTypes.has(AuditAction.STATE_SCHEMA_CHANGE)).toBe(true);
    expect(actionTypes.has(AuditAction.ROUTING_CHANGE)).toBe(true);
    // The brand-color-only re-save did not change the policy → only the
    // initial-setup policy entry, not a second one.
    expect((await policyChangeActions(repos))).toHaveLength(1);
    expect(scheduler.calls).toBe(1); // brand-color change does not re-arm
  });
});