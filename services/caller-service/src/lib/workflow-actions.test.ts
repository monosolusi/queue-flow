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
import type { WorkflowCommand } from '../api/types';

describe('the server owns the command, the panel renders it', () => {
  it('carries each edge’s command through verbatim, source-aware', () => {
    // The same target (CALLING) gets a different command per SOURCE, and the
    // panel keeps no table of its own to second-guess it. The defect this
    // replaces: a client-side map sent every → CALLING edge to recall, which
    // core-api rejects with 409 unless the ticket is SKIPPED.
    const workflow = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'CALL_NEXT'),
      edge('SKIPPED', 'CALLING', 'Panggil Ulang', 'RECALL'),
      edge('CALLING', 'CALLING', 'Panggil Sekali Lagi', 'REANNOUNCE'),
      edge('SERVING', 'CALLING', 'Panggil Ulang Dari Layanan', null, 'NO_COMMAND'),
    );
    expect(ticketActionsFor(workflow, 'SKIPPED')[0].command).toBe('RECALL');
    expect(ticketActionsFor(workflow, 'CALLING')[0].command).toBe('REANNOUNCE');
    expect(ticketActionsFor(workflow, 'SERVING')[0].command).toBeNull();
  });

  it('honours a routing the old client-side table would have contradicted', () => {
    // Proof the local (from, to) table is gone rather than shadowing the wire.
    // The client used to hard-code `SERVING → CALLING` as unroutable and any
    // `→ COMPLETED` as the complete command; if the backend — the side that
    // actually enforces the transition — says otherwise, the backend wins.
    const workflow = workflowActions(
      edge('SERVING', 'CALLING', 'Panggil Ulang Dari Layanan', 'RECALL'),
      edge('SERVING', 'COMPLETED', 'Selesai Layan', null, 'NO_COMMAND'),
    );
    const [recall, complete] = ticketActionsFor(workflow, 'SERVING');
    expect(recall.command).toBe('RECALL');
    expect(complete.command).toBeNull();
  });

  it('keeps the two meaningful self-loops runnable when the server says so', () => {
    // These two do real work in the aggregate: `transferTo` deliberately does
    // not short-circuit on an unchanged status, and re-announce changes no
    // status by design.
    const workflow = workflowActions(
      edge('WAITING', 'WAITING', 'Pindah Kategori', 'TRANSFER'),
      edge('CALLING', 'CALLING', 'Panggil Sekali Lagi', 'REANNOUNCE'),
    );
    expect(ticketActionsFor(workflow, 'WAITING')[0].command).toBe('TRANSFER');
    expect(ticketActionsFor(workflow, 'CALLING')[0].command).toBe('REANNOUNCE');
  });
});

describe('a command this build does not know', () => {
  // The two DTO copies are versioned independently on purpose: core-api ships a
  // ninth command, the panels are redeployed later. In between, an unrecognised
  // command must not render as a live button that only fails on tap.
  const NINTH_COMMAND = 'ESCALATE' as unknown as WorkflowCommand;

  it('degrades to a disabled, explained button instead of a live one', () => {
    const workflow = workflowActions(edge('SERVING', 'ESKALASI', 'Naikkan Ke Supervisor', NINTH_COMMAND));
    const [action] = ticketActionsFor(workflow, 'SERVING');
    expect(action.command).toBeNull();
    expect(action.unavailableReason).toMatch(/belum bisa dijalankan dari panel loket/i);
    // The label stays the admin's — the edge is visible, just not runnable here.
    expect(action.actionLabel).toBe('Naikkan Ke Supervisor');
    // …and it takes the unroutable id, so the render path treats it as one.
    expect(actionTestId(action)).toBe('action-unroutable-ESKALASI');
  });

  it('leaves every known command untouched', () => {
    // The coercion must not quietly break the eight commands that do work.
    const workflow = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'CALL_NEXT'),
      edge('SKIPPED', 'CALLING', 'Panggil Ulang', 'RECALL'),
      edge('CALLING', 'CALLING', 'Panggil Sekali Lagi', 'REANNOUNCE'),
      edge('CALLING', 'SERVING', 'Mulai Melayani', 'SERVE'),
      edge('CALLING', 'SKIPPED', 'Lewati / Absen', 'SKIP'),
      edge('SERVING', 'COMPLETED', 'Selesai Layan', 'COMPLETE'),
      edge('SERVING', 'WAITING', 'Pindah Kategori', 'TRANSFER'),
      edge('SERVING', 'PREPARING', 'Siapkan Dokumen', 'APPLY_TRANSITION'),
    );
    const commands = ['WAITING', 'SKIPPED', 'CALLING', 'SERVING']
      .flatMap((status) => ticketActionsFor(workflow, status))
      .map((a) => a.command);
    // CALL_NEXT is filtered out by ticketActionsFor (it is counter-level).
    expect(commands).toEqual([
      'RECALL',
      'REANNOUNCE',
      'SERVE',
      'SKIP',
      'COMPLETE',
      'TRANSFER',
      'APPLY_TRANSITION',
    ]);
    expect(commands.every((c) => c !== null)).toBe(true);
  });

  it('does not swallow an unknown CALL_NEXT lookalike into the primary button', () => {
    // callNextActionFor matches on the wire command, so a value this build does
    // not know is not a call-next — the button disappears rather than firing an
    // endpoint the server never named.
    const workflow = workflowActions(edge('WAITING', 'CALLING', 'Panggil Berikutnya', NINTH_COMMAND));
    expect(callNextActionFor(workflow)).toBeNull();
    expect(ticketActionsFor(workflow, 'WAITING')[0].command).toBeNull();
  });
});

describe('unavailable reason codes → Indonesian copy', () => {
  it('wraps NO_COMMAND in the "not from the counter panel" wording', () => {
    const workflow = workflowActions(
      edge('SERVING', 'CALLING', 'Panggil Ulang Dari Layanan', null, 'NO_COMMAND'),
    );
    const [action] = ticketActionsFor(workflow, 'SERVING');
    expect(action.command).toBeNull();
    expect(action.unavailableReason).toMatch(/tidak bisa dijalankan dari panel loket/i);
    // The code itself never reaches the screen.
    expect(action.unavailableReason).not.toMatch(/NO_COMMAND/);
  });

  it('gives NO_STATUS_CHANGE its own reason, not the pemanggilan one', () => {
    const workflow = workflowActions(
      edge('SERVING', 'SERVING', 'Lanjut Melayani', null, 'NO_STATUS_CHANGE'),
    );
    const [action] = ticketActionsFor(workflow, 'SERVING');
    expect(action.command).toBeNull();
    expect(action.unavailableReason).toMatch(/tidak mengubah status tiket/i);
    // The two reasons must stay distinct — a manager needs to tell "no endpoint
    // for this" from "this would change nothing".
    expect(action.unavailableReason).not.toMatch(/daftar tunggu/i);
  });

  it('still explains itself when the server sends no code (or one we do not know)', () => {
    const workflow = workflowActions(edge('SERVING', 'CALLING', 'Sesuatu', null));
    const [action] = ticketActionsFor(workflow, 'SERVING');
    expect(action.unavailableReason).toMatch(/belum bisa dijalankan dari panel loket/i);
  });

  it('leaves the reason empty while a command exists', () => {
    const [serve] = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(serve.unavailableReason).toBeNull();
  });
});

describe('ticketActionsFor', () => {
  it('returns exactly the outgoing transitions of the given status, in server order', () => {
    const actions = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(actions.map((a) => [a.to, a.actionLabel, a.command])).toEqual([
      ['SERVING', 'Mulai Melayani', 'SERVE'],
      ['SKIPPED', 'Lewati / Absen', 'SKIP'],
    ]);
  });

  it('excludes the counter-level CALL_NEXT edge (it is not per-ticket)', () => {
    // The PRD-default flow's only WAITING edge is → CALLING, so a waiting
    // ticket offers no per-ticket action out of the box.
    expect(ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'WAITING')).toEqual([]);
  });

  it('surfaces the manager-configured WAITING edges the panel used to hide', () => {
    // The manager's literal example: "dari waiting transisi keluar ada apa saja
    // gitu, itu buttonnya harusnya sesuai".
    const workflow = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'CALL_NEXT'),
      edge('WAITING', 'SKIPPED', 'Lewati / Absen', 'SKIP'),
      edge('WAITING', 'BATAL', 'Batalkan Tiket', 'APPLY_TRANSITION'),
    );
    expect(ticketActionsFor(workflow, 'WAITING').map((a) => [a.to, a.command])).toEqual([
      ['SKIPPED', 'SKIP'],
      ['BATAL', 'APPLY_TRANSITION'],
    ]);
  });

  it('keeps an unroutable edge with a reason instead of dropping it', () => {
    const workflow = workflowActions(
      edge('SERVING', 'CALLING', 'Panggil Ulang Dari Layanan', null, 'NO_COMMAND'),
      edge('SERVING', 'COMPLETED', 'Selesai Layan', 'COMPLETE'),
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
  it("uses the flow's own wording for the CALL_NEXT edge", () => {
    const workflow = workflowActions(edge('WAITING', 'CALLING', 'Panggil Tiket Baru', 'CALL_NEXT'));
    expect(callNextActionFor(workflow)).toMatchObject({
      actionLabel: 'Panggil Tiket Baru',
      command: 'CALL_NEXT',
    });
  });

  it('returns null when the flow has no CALL_NEXT edge (button disappears)', () => {
    const workflow = workflowActions(edge('CALLING', 'SERVING', 'Mulai Melayani', 'SERVE'));
    expect(callNextActionFor(workflow)).toBeNull();
  });

  it('ignores a WAITING edge the server did not resolve to CALL_NEXT', () => {
    // A WAITING → CALLING edge nothing can run is not a call-next button; it is
    // a per-ticket action rendered disabled with its reason.
    const workflow = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Berikutnya', null, 'NO_COMMAND'),
    );
    expect(callNextActionFor(workflow)).toBeNull();
    expect(ticketActionsFor(workflow, 'WAITING')).toHaveLength(1);
  });

  it('falls back to the PRD default when the surface has not loaded (panel stays usable)', () => {
    expect(callNextActionFor(null)).toMatchObject({
      actionLabel: DEFAULT_CALL_NEXT_LABEL,
      command: 'CALL_NEXT',
    });
  });
});

describe('actionTestId / actionRunKey', () => {
  it('keys fixed commands by command and generic ones by target', () => {
    const [serve] = ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'CALLING');
    expect(actionTestId(serve)).toBe('action-serve');
    const custom = ticketActionsFor(
      workflowActions(edge('SERVING', 'PREPARING', 'Siapkan', 'APPLY_TRANSITION')),
      'SERVING',
    )[0];
    expect(actionTestId(custom)).toBe('action-apply-transition-PREPARING');
    const unroutable = ticketActionsFor(
      workflowActions(edge('SERVING', 'CALLING', 'X', null, 'NO_COMMAND')),
      'SERVING',
    )[0];
    expect(actionTestId(unroutable)).toBe('action-unroutable-CALLING');
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
