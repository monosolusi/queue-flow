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
import type { TransitionActionType } from '../api/types';

describe('the flow declares what an edge does, the panel renders it', () => {
  it('carries each edge’s declared action through verbatim', () => {
    // The panel keeps no table of its own, and neither does the backend any
    // more. The defect this replaces was a resolution keyed on the (from, to)
    // pair: every edge into WAITING was ruled a category move, so a flow drawn
    // to put a ticket back in the queue rendered a "Pindah Kategori" button
    // asking for a destination category.
    const workflow = workflowActions(
      edge('CALLING', 'WAITING', 'Kembalikan ke Antrian'),
      edge('SERVING', 'WAITING', 'Pindah Kategori', 'TRANSFER_CATEGORY'),
    );
    expect(ticketActionsFor(workflow, 'CALLING')[0].action).toBe('UPDATE_STATUS');
    expect(ticketActionsFor(workflow, 'SERVING')[0].action).toBe('TRANSFER_CATEGORY');
  });

  it('gives two edges with the same endpoints opposite meanings', () => {
    // The sharpest form of the same point: identical `from`/`to`, different
    // action. No rule over endpoints could tell these apart.
    const requeue = workflowActions(edge('CALLING', 'WAITING', 'Kembalikan ke Antrian'));
    const transfer = workflowActions(
      edge('CALLING', 'WAITING', 'Pindah Kategori', 'TRANSFER_CATEGORY'),
    );
    expect(ticketActionsFor(requeue, 'CALLING')[0].action).toBe('UPDATE_STATUS');
    expect(ticketActionsFor(transfer, 'CALLING')[0].action).toBe('TRANSFER_CATEGORY');
  });

  it('runs any target the flow allows, with no edge left unroutable', () => {
    // Each of these was once a distinct command, and one of them
    // (`SERVING → CALLING`) had no command at all and rendered permanently
    // disabled. A per-ticket transition reaches every one.
    const workflow = workflowActions(
      edge('SERVING', 'CALLING', 'Panggil Ulang Dari Layanan'),
      edge('SERVING', 'COMPLETED', 'Selesai Layan'),
      edge('SERVING', 'PREPARING', 'Siapkan Dokumen'),
    );
    const actions = ticketActionsFor(workflow, 'SERVING');
    expect(actions.map((a) => a.action)).toEqual([
      'UPDATE_STATUS',
      'UPDATE_STATUS',
      'UPDATE_STATUS',
    ]);
    expect(actions.every((a) => a.unavailableReason === null)).toBe(true);
  });

  it('keeps the two meaningful self-loops runnable when the server says so', () => {
    // Both do real work in the aggregate: `transferTo` deliberately does not
    // short-circuit on an unchanged status, and arriving in CALLING re-announces
    // by design.
    const workflow = workflowActions(
      edge('WAITING', 'WAITING', 'Pindah Kategori', 'TRANSFER_CATEGORY'),
      edge('CALLING', 'CALLING', 'Panggil Sekali Lagi'),
    );
    expect(ticketActionsFor(workflow, 'WAITING')[0].unavailableReason).toBeNull();
    expect(ticketActionsFor(workflow, 'CALLING')[0].unavailableReason).toBeNull();
  });
});

describe('an action this build does not know', () => {
  // The two DTO copies are versioned independently on purpose: core-api ships a
  // third action, the panels are redeployed later. In between, an unrecognised
  // action must not render as a live button that only fails on tap.
  const THIRD_ACTION = 'SEND_WEBHOOK' as unknown as TransitionActionType;

  it('degrades to a disabled, explained button instead of a live one', () => {
    const workflow = workflowActions(
      edge('SERVING', 'ESKALASI', 'Naikkan Ke Supervisor', THIRD_ACTION),
    );
    const [action] = ticketActionsFor(workflow, 'SERVING');
    expect(action.action).toBeNull();
    expect(action.unavailableReason).toMatch(/belum bisa dijalankan dari panel loket/i);
    // The label stays the admin's — the edge is visible, just not runnable here.
    expect(action.actionLabel).toBe('Naikkan Ke Supervisor');
    // …and it takes the unroutable id, so the render path treats it as one.
    expect(actionTestId(action)).toBe('action-unroutable-ESKALASI');
  });

  it('leaves every known action untouched', () => {
    // The coercion must not quietly break the two actions that do work.
    const workflow = workflowActions(
      edge('CALLING', 'SERVING', 'Mulai Melayani'),
      edge('SERVING', 'WAITING', 'Pindah Kategori', 'TRANSFER_CATEGORY'),
    );
    const actions = ['CALLING', 'SERVING'].flatMap((s) => ticketActionsFor(workflow, s));
    expect(actions.map((a) => a.action)).toEqual(['UPDATE_STATUS', 'TRANSFER_CATEGORY']);
    expect(actions.every((a) => a.unavailableReason === null)).toBe(true);
  });

  it('keeps an edge it cannot run off the primary button, but still on screen', () => {
    // The primary button fires the counter-level endpoint unconditionally, so it
    // must only claim an edge whose declaration it can honour. This one moves to
    // the per-ticket surface, where it renders disabled and explained — visible
    // either way, which is the part that matters.
    const workflow = workflowActions(edge('WAITING', 'CALLING', 'Panggil Berikutnya', THIRD_ACTION));
    expect(callNextActionFor(workflow)).toBeNull();
    const [perTicket] = ticketActionsFor(workflow, 'WAITING');
    expect(perTicket).toMatchObject({ action: null, actionLabel: 'Panggil Berikutnya' });
    expect(perTicket.unavailableReason).toMatch(/belum bisa dijalankan/i);
  });
});

describe('unavailable reason codes → Indonesian copy', () => {
  it('gives NO_STATUS_CHANGE its own wording, and never leaks the code', () => {
    const workflow = workflowActions(
      edge('SERVING', 'SERVING', 'Lanjut Melayani', 'UPDATE_STATUS', 'NO_STATUS_CHANGE'),
    );
    const [action] = ticketActionsFor(workflow, 'SERVING');
    expect(action.unavailableReason).toMatch(/tidak mengubah status tiket/i);
    expect(action.unavailableReason).not.toMatch(/NO_STATUS_CHANGE/);
  });

  it('still explains itself when the server sends a code we do not know', () => {
    const workflow = workflowActions(
      edge('SERVING', 'CALLING', 'Sesuatu', 'UPDATE_STATUS', 'FUTURE_CODE' as never),
    );
    const [action] = ticketActionsFor(workflow, 'SERVING');
    expect(action.unavailableReason).toMatch(/belum bisa dijalankan dari panel loket/i);
  });

  it('leaves the reason empty on a runnable edge', () => {
    const [serve] = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(serve.unavailableReason).toBeNull();
  });
});

describe('ticketActionsFor', () => {
  it('returns exactly the outgoing transitions of the given status, in server order', () => {
    const actions = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(actions.map((a) => [a.to, a.actionLabel, a.action])).toEqual([
      ['SERVING', 'Mulai Melayani', 'UPDATE_STATUS'],
      ['SKIPPED', 'Lewati / Absen', 'UPDATE_STATUS'],
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
      edge('SERVING', 'SERVING', 'Lanjut Melayani', 'UPDATE_STATUS', 'NO_STATUS_CHANGE'),
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
      action: 'UPDATE_STATUS',
    });
  });

  it('returns null when the flow has no WAITING → CALLING edge (button disappears)', () => {
    const workflow = workflowActions(edge('CALLING', 'SERVING', 'Mulai Melayani'));
    expect(callNextActionFor(workflow)).toBeNull();
  });

  it('renders a do-nothing WAITING → CALLING edge disabled rather than live', () => {
    const workflow = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'UPDATE_STATUS', 'NO_STATUS_CHANGE'),
    );
    expect(callNextActionFor(workflow)?.unavailableReason).toMatch(/tidak mengubah status/i);
  });

  it('leaves a WAITING → CALLING edge declared a category move to the per-ticket surface', () => {
    // Rolling-deploy defence in depth, like the unknown-action case above: core-api
    // refuses to SAVE a category move that targets anything but WAITING, so this
    // shape cannot come from a current server — but a panel may outlive the config
    // that produced it. Do not simplify the check away on the grounds that the
    // configuration is impossible; it is impossible to create, not to receive.
    //
    // Its declaration cannot be honoured by the counter-level endpoint (no ticket
    // is picked yet, let alone a destination category), so the primary button does
    // not claim it — the waiting rows render it as the category move it says it is.
    const workflow = workflowActions(
      edge('WAITING', 'CALLING', 'Pindah Kategori Lalu Panggil', 'TRANSFER_CATEGORY'),
    );
    expect(callNextActionFor(workflow)).toBeNull();
    expect(ticketActionsFor(workflow, 'WAITING')).toEqual([
      expect.objectContaining({ action: 'TRANSFER_CATEGORY', unavailableReason: null }),
    ]);
  });

  it('falls back to the PRD default when the surface has not loaded (panel stays usable)', () => {
    expect(callNextActionFor(null)).toMatchObject({
      actionLabel: DEFAULT_CALL_NEXT_LABEL,
      action: 'UPDATE_STATUS',
    });
  });
});

describe('actionTestId / actionRunKey', () => {
  it('keys a button by its declared action and target', () => {
    const [serve] = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(actionTestId(serve)).toBe('action-update-status-SERVING');
    const transfer = ticketActionsFor(
      workflowActions(edge('SERVING', 'WAITING', 'Pindah Kategori', 'TRANSFER_CATEGORY')),
      'SERVING',
    )[0];
    expect(actionTestId(transfer)).toBe('action-transfer-category-WAITING');
  });

  it('distinguishes two edges that run the same action from one status', () => {
    // Same action, different target — the target is what tells the buttons apart.
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
