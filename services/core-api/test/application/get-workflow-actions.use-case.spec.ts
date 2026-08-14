import {
  GetWorkflowActionsUseCase,
  type WorkflowActionDto,
} from '../../src/application/queue';
import type { ITransitionPolicyResolver } from '../../src/domain/queue';
import { SystemNotConfiguredException, TransitionAction } from '../../src/domain/shared';
import {
  StateMachine,
  StateSchema,
  StateTransitionRule,
} from '../../src/domain/store-config';
import { fakePolicyResolver } from './test-doubles';

/** `[from, to, actionLabel, action?]` — `action` omitted means UPDATE_STATUS. */
type EdgeSpec = readonly [string, string, string, TransitionAction?];

/**
 * Builds a real {@link StateMachine} (not a hand-rolled fake) over exactly the
 * given edges, deriving the schema from the states they mention. Using the real
 * policy implementation means these specs also cover `describeGraph()`, the
 * enumeration capability the use case reads the graph through — including whether
 * it carries each edge's declared action.
 */
function machineOf(
  edges: readonly EdgeSpec[],
  extraStates: readonly string[] = [],
): StateMachine {
  const states = [...new Set([...edges.flatMap(([from, to]) => [from, to]), ...extraStates])];
  return new StateMachine(
    StateSchema.of(states),
    edges.map((e) => StateTransitionRule.of(e[0], e[1], e[2], e[3])),
  );
}

/** Runs the use case against a policy built from `edges`. */
async function actionsFor(
  edges: readonly EdgeSpec[],
  extraStates: readonly string[] = [],
) {
  const useCase = new GetWorkflowActionsUseCase(fakePolicyResolver(machineOf(edges, extraStates)));
  return (await useCase.execute()).byStatus;
}

describe('GetWorkflowActionsUseCase (publishing the flow as the counter panel surface)', () => {
  describe('the declared action is passed through, never inferred from the edge', () => {
    // The pairs the deleted resolution table used to key on. What matters now is
    // that the endpoints have NO influence on the published action — only the
    // manager's declaration does. `PAYMENT` / `PREPARING` stand in for
    // wizard-configured custom states.
    const pairs: readonly (readonly [string, string])[] = [
      ['WAITING', 'CALLING'],
      ['SKIPPED', 'CALLING'],
      ['SERVING', 'CALLING'],
      ['COMPLETED', 'CALLING'],
      ['PAYMENT', 'CALLING'],
      ['CALLING', 'WAITING'],
      ['SERVING', 'WAITING'],
      ['SKIPPED', 'WAITING'],
      ['COMPLETED', 'WAITING'],
      ['PAYMENT', 'WAITING'],
      ['CALLING', 'SERVING'],
      ['PAYMENT', 'SERVING'],
      ['SERVING', 'COMPLETED'],
      ['PAYMENT', 'COMPLETED'],
      ['CALLING', 'SKIPPED'],
      ['WAITING', 'SKIPPED'],
      ['SERVING', 'PAYMENT'],
      ['CALLING', 'PREPARING'],
      ['PAYMENT', 'PREPARING'],
    ];

    it.each(pairs)('%s -> %s defaults to UPDATE_STATUS and is runnable', async (from, to) => {
      const byStatus = await actionsFor([[from, to, 'Aksi']]);

      expect(byStatus[from]).toEqual([
        { from, to, actionLabel: 'Aksi', action: 'UPDATE_STATUS', unavailableReason: null },
      ]);
    });

    it.each(pairs)(
      '%s -> %s is a category transfer when — and only when — declared one',
      async (from, to) => {
        const byStatus = await actionsFor([
          [from, to, 'Pindah Kategori', TransitionAction.TRANSFER_CATEGORY],
        ]);

        expect(byStatus[from]).toEqual([
          {
            from,
            to,
            actionLabel: 'Pindah Kategori',
            action: 'TRANSFER_CATEGORY',
            unavailableReason: null,
          },
        ]);
      },
    );

    it('reports the manager\'s CALLING -> WAITING re-queue as a plain status change', async () => {
      // The reported defect: this edge was published as a category move purely
      // because its target was WAITING, so the panel rendered a "Pindah Kategori"
      // button that demanded a destination category the counter may not serve.
      const byStatus = await actionsFor([['CALLING', 'WAITING', 'Kembalikan ke Antrian']]);

      expect(byStatus.CALLING).toEqual([
        {
          from: 'CALLING',
          to: 'WAITING',
          actionLabel: 'Kembalikan ke Antrian',
          action: 'UPDATE_STATUS',
          unavailableReason: null,
        },
      ]);
    });
  });

  describe('the one remaining ruling: would running the edge do anything?', () => {
    const selfLoops: readonly [
      state: string,
      action: TransitionAction,
      reason: WorkflowActionDto['unavailableReason'],
    ][] = [
      // A re-announcement IS the point of drawing CALLING -> CALLING.
      ['CALLING', TransitionAction.UPDATE_STATUS, null],
      // A category move is a real change whether or not the status also moves.
      ['WAITING', TransitionAction.TRANSFER_CATEGORY, null],
      ['PAYMENT', TransitionAction.TRANSFER_CATEGORY, null],
      // Everything else short-circuits in the aggregate: 200, no change, no
      // broadcast — which reads as a broken panel unless we say so.
      ['WAITING', TransitionAction.UPDATE_STATUS, 'NO_STATUS_CHANGE'],
      ['SERVING', TransitionAction.UPDATE_STATUS, 'NO_STATUS_CHANGE'],
      ['COMPLETED', TransitionAction.UPDATE_STATUS, 'NO_STATUS_CHANGE'],
      ['SKIPPED', TransitionAction.UPDATE_STATUS, 'NO_STATUS_CHANGE'],
      ['PAYMENT', TransitionAction.UPDATE_STATUS, 'NO_STATUS_CHANGE'],
    ];

    it.each(selfLoops)(
      'a %s self-loop declared %s reports %s',
      async (state, action, reason) => {
        const byStatus = await actionsFor([[state, state, 'Aksi', action]]);

        expect(byStatus[state][0].unavailableReason).toBe(reason);
      },
    );

    it('never marks a real transition unavailable', async () => {
      const byStatus = await actionsFor([
        ['WAITING', 'CALLING', 'Panggil Berikutnya'],
        ['CALLING', 'WAITING', 'Kembalikan ke Antrian'],
        ['CALLING', 'PAYMENT', 'Ke Pembayaran'],
        ['PAYMENT', 'COMPLETED', 'Selesai'],
      ]);

      const all = Object.values(byStatus).flat();
      expect(all).toHaveLength(4);
      expect(all.every((a) => a.unavailableReason === null)).toBe(true);
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
            action: 'UPDATE_STATUS',
            unavailableReason: null,
          },
        ],
        CALLING: [
          {
            from: 'CALLING',
            to: 'SERVING',
            actionLabel: 'Mulai Melayani',
            action: 'UPDATE_STATUS',
            unavailableReason: null,
          },
          {
            from: 'CALLING',
            to: 'SKIPPED',
            actionLabel: 'Lewati / Absen',
            action: 'UPDATE_STATUS',
            unavailableReason: null,
          },
        ],
        SERVING: [
          {
            from: 'SERVING',
            to: 'COMPLETED',
            actionLabel: 'Selesai Layan',
            action: 'UPDATE_STATUS',
            unavailableReason: null,
          },
        ],
        SKIPPED: [
          {
            from: 'SKIPPED',
            to: 'CALLING',
            actionLabel: 'Panggil Ulang',
            action: 'UPDATE_STATUS',
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
        ['CALLING', 'WAITING', 'Pindah Kategori', TransitionAction.TRANSFER_CATEGORY],
      ]);

      expect(byStatus.CALLING.map((a) => [a.to, a.action])).toEqual([
        ['SERVING', 'UPDATE_STATUS'],
        ['SKIPPED', 'UPDATE_STATUS'],
        ['PAYMENT', 'UPDATE_STATUS'],
        ['WAITING', 'TRANSFER_CATEGORY'],
      ]);
    });

    it('carries the configured Indonesian action label verbatim', async () => {
      const byStatus = await actionsFor([['CALLING', 'WAITING', 'Kembalikan ke Antrian']]);

      expect(byStatus.CALLING[0].actionLabel).toBe('Kembalikan ke Antrian');
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
          action: 'UPDATE_STATUS',
          unavailableReason: null,
        },
      ]);
    });
  });
});
