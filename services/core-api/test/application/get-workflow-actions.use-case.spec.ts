import {
  GetWorkflowActionsUseCase,
  type WorkflowActionDto,
  type WorkflowCommand,
} from '../../src/application/queue';
import type { ITransitionPolicyResolver } from '../../src/domain/queue';
import { SystemNotConfiguredException } from '../../src/domain/shared';
import {
  StateMachine,
  StateSchema,
  StateTransitionRule,
} from '../../src/domain/store-config';
import { fakePolicyResolver } from './test-doubles';

/**
 * Builds a real {@link StateMachine} (not a hand-rolled fake) over exactly the
 * given edges, deriving the schema from the states they mention. Using the real
 * policy implementation means these specs also cover `describeGraph()`, the
 * enumeration capability the use case reads the graph through.
 */
function machineOf(
  edges: readonly (readonly [string, string, string])[],
  extraStates: readonly string[] = [],
): StateMachine {
  const states = [...new Set([...edges.flatMap(([from, to]) => [from, to]), ...extraStates])];
  return new StateMachine(
    StateSchema.of(states),
    edges.map(([from, to, label]) => StateTransitionRule.of(from, to, label)),
  );
}

/** Runs the use case against a policy built from `edges`. */
async function actionsFor(
  edges: readonly (readonly [string, string, string])[],
  extraStates: readonly string[] = [],
) {
  const useCase = new GetWorkflowActionsUseCase(fakePolicyResolver(machineOf(edges, extraStates)));
  return (await useCase.execute()).byStatus;
}

describe('GetWorkflowActionsUseCase (which command realizes each configured edge)', () => {
  describe('resolution table — the backend is the authority for edge -> command', () => {
    // Every rule, keyed on the (from, to) pair. `PAYMENT` / `PREPARING` stand in
    // for wizard-configured custom states.
    const cases: readonly [
      from: string,
      to: string,
      command: WorkflowCommand | null,
      reason: WorkflowActionDto['unavailableReason'],
    ][] = [
      // Into CALLING — three distinct commands plus a dead end.
      ['WAITING', 'CALLING', 'CALL_NEXT', null],
      ['SKIPPED', 'CALLING', 'RECALL', null],
      ['CALLING', 'CALLING', 'REANNOUNCE', null],
      ['SERVING', 'CALLING', null, 'NO_COMMAND'],
      ['COMPLETED', 'CALLING', null, 'NO_COMMAND'],
      ['PAYMENT', 'CALLING', null, 'NO_COMMAND'],
      // Into WAITING — the category move, self-loop included.
      ['CALLING', 'WAITING', 'TRANSFER', null],
      ['WAITING', 'WAITING', 'TRANSFER', null],
      ['SERVING', 'WAITING', 'TRANSFER', null],
      ['SKIPPED', 'WAITING', 'TRANSFER', null],
      ['COMPLETED', 'WAITING', 'TRANSFER', null],
      ['PAYMENT', 'WAITING', 'TRANSFER', null],
      // The remaining canonical targets — dedicated commands.
      ['CALLING', 'SERVING', 'SERVE', null],
      ['PAYMENT', 'SERVING', 'SERVE', null],
      ['SERVING', 'COMPLETED', 'COMPLETE', null],
      ['PAYMENT', 'COMPLETED', 'COMPLETE', null],
      ['CALLING', 'SKIPPED', 'SKIP', null],
      ['WAITING', 'SKIPPED', 'SKIP', null],
      // Custom (non-canonical) targets — the generic transition endpoint.
      ['SERVING', 'PAYMENT', 'APPLY_TRANSITION', null],
      ['CALLING', 'PREPARING', 'APPLY_TRANSITION', null],
      ['PAYMENT', 'PREPARING', 'APPLY_TRANSITION', null],
      // Self-loops that are neither a re-announce nor a transfer: the aggregate
      // short-circuits on `from === target`, so no command changes anything.
      ['SERVING', 'SERVING', null, 'NO_STATUS_CHANGE'],
      ['COMPLETED', 'COMPLETED', null, 'NO_STATUS_CHANGE'],
      ['SKIPPED', 'SKIPPED', null, 'NO_STATUS_CHANGE'],
      ['PAYMENT', 'PAYMENT', null, 'NO_STATUS_CHANGE'],
    ];

    it.each(cases)('%s -> %s resolves to %s / %s', async (from, to, command, reason) => {
      const byStatus = await actionsFor([[from, to, 'Aksi']]);

      expect(byStatus[from]).toEqual([
        { from, to, actionLabel: 'Aksi', command, unavailableReason: reason },
      ]);
    });

    it('exactly one of command / unavailableReason is non-null for every rule', async () => {
      for (const [from, to] of cases) {
        const [action] = (await actionsFor([[from, to, 'Aksi']]))[from];
        expect(action.command === null).toBe(action.unavailableReason !== null);
      }
    });
  });

  describe('self-loop ordering — the two meaningful self-loops are decided first', () => {
    it('CALLING -> CALLING is a re-announce, not NO_STATUS_CHANGE', async () => {
      const byStatus = await actionsFor([['CALLING', 'CALLING', 'Panggil Lagi']]);

      expect(byStatus.CALLING[0]).toMatchObject({
        command: 'REANNOUNCE',
        unavailableReason: null,
      });
    });

    it('WAITING -> WAITING is a transfer, not NO_STATUS_CHANGE', async () => {
      // `transferTo` deliberately does not short-circuit on `from === to` — a
      // transfer is a category move whether or not the status also changes.
      const byStatus = await actionsFor([['WAITING', 'WAITING', 'Pindah Kategori']]);

      expect(byStatus.WAITING[0]).toMatchObject({
        command: 'TRANSFER',
        unavailableReason: null,
      });
    });

    it('a custom-state self-loop still falls through to NO_STATUS_CHANGE', async () => {
      const byStatus = await actionsFor([['PAYMENT', 'PAYMENT', 'Ulangi Pembayaran']]);

      expect(byStatus.PAYMENT[0]).toMatchObject({
        command: null,
        unavailableReason: 'NO_STATUS_CHANGE',
      });
    });
  });

  describe('graph projection', () => {
    it('projects the PRD §7 default machine keyed by source status', async () => {
      const useCase = new GetWorkflowActionsUseCase(fakePolicyResolver(StateMachine.DEFAULT));

      const { byStatus } = await useCase.execute();

      expect(byStatus).toEqual({
        WAITING: [
          {
            from: 'WAITING',
            to: 'CALLING',
            actionLabel: 'Panggil Berikutnya',
            command: 'CALL_NEXT',
            unavailableReason: null,
          },
        ],
        CALLING: [
          {
            from: 'CALLING',
            to: 'SERVING',
            actionLabel: 'Mulai Melayani',
            command: 'SERVE',
            unavailableReason: null,
          },
          {
            from: 'CALLING',
            to: 'SKIPPED',
            actionLabel: 'Lewati / Absen',
            command: 'SKIP',
            unavailableReason: null,
          },
        ],
        SERVING: [
          {
            from: 'SERVING',
            to: 'COMPLETED',
            actionLabel: 'Selesai Layan',
            command: 'COMPLETE',
            unavailableReason: null,
          },
        ],
        SKIPPED: [
          {
            from: 'SKIPPED',
            to: 'CALLING',
            actionLabel: 'Panggil Ulang',
            command: 'RECALL',
            unavailableReason: null,
          },
        ],
        // A sink: present with an empty list, never absent.
        COMPLETED: [],
      });
    });

    it('includes an isolated schema state with no outgoing edge as an empty list', async () => {
      const byStatus = await actionsFor(
        [['WAITING', 'CALLING', 'Panggil Berikutnya']],
        ['PAYMENT'],
      );

      expect(byStatus.PAYMENT).toEqual([]);
      expect(Object.keys(byStatus).sort()).toEqual(['CALLING', 'PAYMENT', 'WAITING']);
    });

    it('keeps multiple edges out of one status in configuration order', async () => {
      const byStatus = await actionsFor([
        ['CALLING', 'SERVING', 'Mulai Melayani'],
        ['CALLING', 'SKIPPED', 'Lewati / Absen'],
        ['CALLING', 'PAYMENT', 'Ke Pembayaran'],
        ['CALLING', 'CALLING', 'Panggil Lagi'],
      ]);

      expect(byStatus.CALLING.map((a) => [a.to, a.command])).toEqual([
        ['SERVING', 'SERVE'],
        ['SKIPPED', 'SKIP'],
        ['PAYMENT', 'APPLY_TRANSITION'],
        ['CALLING', 'REANNOUNCE'],
      ]);
    });

    it('carries the configured Indonesian action label verbatim', async () => {
      const byStatus = await actionsFor([['CALLING', 'WAITING', 'Pindah Kategori']]);

      expect(byStatus.CALLING[0].actionLabel).toBe('Pindah Kategori');
    });
  });

  describe('active-policy resolution', () => {
    it('propagates SystemNotConfiguredException before first-run setup', async () => {
      const resolver: ITransitionPolicyResolver = {
        getActivePolicy: async () => {
          throw new SystemNotConfiguredException();
        },
      };

      await expect(new GetWorkflowActionsUseCase(resolver).execute()).rejects.toBeInstanceOf(
        SystemNotConfiguredException,
      );
    });

    it('resolves the policy per execution, so a config edit takes effect immediately', async () => {
      let policy = StateMachine.DEFAULT;
      const resolver: ITransitionPolicyResolver = { getActivePolicy: async () => policy };
      const useCase = new GetWorkflowActionsUseCase(resolver);

      expect((await useCase.execute()).byStatus.CALLING).toHaveLength(2);

      policy = machineOf([['CALLING', 'CALLING', 'Panggil Lagi']]);

      expect((await useCase.execute()).byStatus.CALLING).toEqual([
        {
          from: 'CALLING',
          to: 'CALLING',
          actionLabel: 'Panggil Lagi',
          command: 'REANNOUNCE',
          unavailableReason: null,
        },
      ]);
    });
  });
});
