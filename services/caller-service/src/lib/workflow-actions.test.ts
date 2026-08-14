import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALL_NEXT_LABEL,
  actionRunKey,
  actionTestId,
  callNextActionFor,
  ticketActionsFor,
  transferCandidates,
} from './workflow-actions';
import { PRD_DEFAULT_WORKFLOW, edge, workflowActions } from '../test/workflow-fixtures';
import type { BoundCounter } from '../state/counter-binding';

describe('the flow declares the outgoing transitions, the panel renders them', () => {
  it('runs any target the flow allows, with no edge left unroutable', () => {
    // Each of these was once a distinct command, and one of them
    // (`SERVING → CALLING`) had no command at all and rendered permanently
    // disabled. A per-ticket transition reaches every one as a plain status
    // change.
    const workflow = workflowActions(
      edge('SERVING', 'CALLING', 'Panggil Ulang Dari Layanan'),
      edge('SERVING', 'COMPLETED', 'Selesai Layan'),
      edge('SERVING', 'PREPARING', 'Siapkan Dokumen'),
    );
    const actions = ticketActionsFor(workflow, 'SERVING');
    expect(actions.map((a) => a.to)).toEqual(['CALLING', 'COMPLETED', 'PREPARING']);
    expect(actions.every((a) => a.unavailableReason === null)).toBe(true);
  });

  it('keeps the re-announce self-loop runnable when the server says so', () => {
    // `CALLING → CALLING` does real work in the aggregate: arriving in CALLING
    // re-announces by design, and `transferTo` deliberately does not short-circuit
    // on an unchanged status.
    const workflow = workflowActions(edge('CALLING', 'CALLING', 'Panggil Sekali Lagi'));
    expect(ticketActionsFor(workflow, 'CALLING')[0].unavailableReason).toBeNull();
  });

  it('treats every edge as a plain status change (no per-edge action flag)', () => {
    // A re-queue `→ WAITING` and any other edge are the same thing here: a
    // status change. "Pindah Kategori" is no longer a flow edge, so the old
    // distinction between a re-queue and a category move on the same `→ WAITING`
    // endpoints is gone — both are status changes now.
    const workflow = workflowActions(
      edge('CALLING', 'WAITING', 'Kembalikan ke Antrian'),
      edge('SERVING', 'WAITING', 'Kembalikan ke Antrian'),
    );
    const calling = ticketActionsFor(workflow, 'CALLING')[0];
    const serving = ticketActionsFor(workflow, 'SERVING')[0];
    expect(calling.unavailableReason).toBeNull();
    expect(serving.unavailableReason).toBeNull();
    expect(actionTestId(calling)).toBe('action-status-WAITING');
  });
});

describe('an edge the server marks unrunnable', () => {
  it('still explains itself when the server sends a reason code we do not know', () => {
    // The two DTO copies are versioned independently on purpose: core-api may
    // ship a new reason code, the panels are redeployed later. In between, an
    // unrecognised code must not render as a live button that only fails on tap.
    const workflow = workflowActions(
      edge('SERVING', 'ESKALASI', 'Naikkan Ke Supervisor', 'FUTURE_CODE' as never),
    );
    const [action] = ticketActionsFor(workflow, 'SERVING');
    expect(action.unavailableReason).toMatch(/belum bisa dijalankan dari panel loket/i);
    // The label stays the admin's — the edge is visible, just not runnable here.
    expect(action.actionLabel).toBe('Naikkan Ke Supervisor');
    // …and it takes the unroutable id, so the render path treats it as one.
    expect(actionTestId(action)).toBe('action-unroutable-ESKALASI');
  });
});

describe('unavailable reason codes → Indonesian copy', () => {
  it('gives NO_STATUS_CHANGE its own wording, and never leaks the code', () => {
    const workflow = workflowActions(
      edge('SERVING', 'SERVING', 'Lanjut Melayani', 'NO_STATUS_CHANGE'),
    );
    const [action] = ticketActionsFor(workflow, 'SERVING');
    expect(action.unavailableReason).toMatch(/tidak mengubah status tiket/i);
    expect(action.unavailableReason).not.toMatch(/NO_STATUS_CHANGE/);
  });

  it('leaves the reason empty on a runnable edge', () => {
    const [serve] = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(serve.unavailableReason).toBeNull();
  });
});

describe('ticketActionsFor', () => {
  it('returns exactly the outgoing transitions of the given status, in server order', () => {
    const actions = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(actions.map((a) => [a.to, a.actionLabel])).toEqual([
      ['SERVING', 'Mulai Melayani'],
      ['SKIPPED', 'Lewati / Absen'],
    ]);
  });

  it('excludes the counter-level WAITING → CALLING edge (it is not per-ticket)', () => {
    // The PRD-default flow's only WAITING edge is → CALLING, so a waiting
    // ticket offers no per-ticket action out of the box.
    expect(ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'WAITING')).toEqual([]);
  });

  it('surfaces the manager-configured WAITING edges the panel used to hide', () => {
    // The manager's literal example: "dari waiting transisi keluar ada apa saja
    // gitu, itu buttonnya harusnya sesuai".
    const workflow = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Berikutnya'),
      edge('WAITING', 'SKIPPED', 'Lewati / Absen'),
      edge('WAITING', 'BATAL', 'Batalkan Tiket'),
    );
    expect(ticketActionsFor(workflow, 'WAITING').map((a) => a.to)).toEqual(['SKIPPED', 'BATAL']);
  });

  it('keeps a do-nothing edge with a reason instead of dropping it', () => {
    const workflow = workflowActions(
      edge('SERVING', 'SERVING', 'Lanjut Melayani', 'NO_STATUS_CHANGE'),
      edge('SERVING', 'COMPLETED', 'Selesai Layan'),
    );
    expect(ticketActionsFor(workflow, 'SERVING')).toHaveLength(2);
  });

  it('yields nothing for an unloaded surface or an unknown status', () => {
    expect(ticketActionsFor(null, 'CALLING')).toEqual([]);
    expect(ticketActionsFor(PRD_DEFAULT_WORKFLOW, undefined)).toEqual([]);
    expect(ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'PREPARING')).toEqual([]);
  });
});

describe('callNextActionFor', () => {
  it("uses the flow's own wording for the WAITING → CALLING edge", () => {
    const workflow = workflowActions(edge('WAITING', 'CALLING', 'Panggil Tiket Baru'));
    expect(callNextActionFor(workflow)).toMatchObject({
      actionLabel: 'Panggil Tiket Baru',
    });
  });

  it('returns null when the flow has no WAITING → CALLING edge (button disappears)', () => {
    const workflow = workflowActions(edge('CALLING', 'SERVING', 'Mulai Melayani'));
    expect(callNextActionFor(workflow)).toBeNull();
  });

  it('renders a do-nothing WAITING → CALLING edge disabled rather than live', () => {
    const workflow = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'NO_STATUS_CHANGE'),
    );
    expect(callNextActionFor(workflow)?.unavailableReason).toMatch(/tidak mengubah status/i);
  });

  it('falls back to the PRD default when the surface has not loaded (panel stays usable)', () => {
    expect(callNextActionFor(null)).toMatchObject({
      actionLabel: DEFAULT_CALL_NEXT_LABEL,
    });
  });
});

describe('actionTestId / actionRunKey', () => {
  it('keys a button by its target status', () => {
    const [serve] = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(actionTestId(serve)).toBe('action-status-SERVING');
  });

  it('distinguishes two edges by their target from one status', () => {
    // Different targets — the target is what tells the buttons apart.
    const workflow = workflowActions(
      edge('SERVING', 'PREPARING', 'Siapkan Dokumen'),
      edge('SERVING', 'PEMBAYARAN', 'Ke Pembayaran'),
    );
    const [a, b] = ticketActionsFor(workflow, 'SERVING');
    expect(actionTestId(a)).not.toBe(actionTestId(b));
  });

  it('scopes the pending key per ticket so one row does not disable another', () => {
    const [serve] = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(actionRunKey('t1', serve)).not.toBe(actionRunKey('t2', serve));
  });
});

describe('transferCandidates', () => {
  const bound: BoundCounter = {
    counterId: 1,
    counterName: 'Loket 1',
    assignedCategoryIds: ['cat-a', 'cat-b'],
    assignedCategories: [
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Kasir' },
    ],
  };

  it("excludes the ticket's own category", () => {
    expect(transferCandidates(bound, 'cat-a')).toEqual([{ id: 'cat-b', name: 'Kasir' }]);
  });

  it('falls back to id-only labels for a legacy binding without category names', () => {
    const legacy: BoundCounter = { ...bound, assignedCategories: [] };
    expect(transferCandidates(legacy, 'cat-a')).toEqual([{ id: 'cat-b', name: 'cat-b' }]);
  });
});