import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CounterRoutingEditor, type RoutingRuleRow } from './CounterRoutingEditor';
import { PRIORITY_POLICY_LABELS, PRIORITY_POLICY_DESCRIPTIONS } from '../lib/labels';
import type { PriorityPolicy } from '../api/types';

const CATEGORIES = [
  { code: 'A', name: 'Customer Service' },
  { code: 'B', name: 'Kasir & Pembayaran' },
  { code: 'C', name: 'Farmasi' },
];

function makeRule(overrides: Partial<RoutingRuleRow> = {}): RoutingRuleRow {
  return {
    counterId: 1,
    counterName: 'Counter 1',
    assignedCategoryCodes: [],
    priorityPolicy: 'FIFO_GLOBAL' as PriorityPolicy,
    ...overrides,
  };
}

describe('CounterRoutingEditor', () => {
  it('renders a row per routing rule with the right cells (name fallback, priority label, joined category names, empty hint)', () => {
    const rules: RoutingRuleRow[] = [
      makeRule({ counterId: 1, counterName: 'Loket 1', assignedCategoryCodes: ['A', 'B'] }),
      makeRule({ counterId: 2, counterName: '', assignedCategoryCodes: [] }),
    ];
    render(
      <CounterRoutingEditor
        routingRules={rules}
        categories={CATEGORIES}
        onUpdate={() => {}}
        idPrefix="routing"
      />,
    );

    // Row 1: explicit name, FIFO label, both category names joined.
    expect(screen.getByTestId('routing-counter-name-0')).toHaveTextContent('Loket 1');
    expect(screen.getByTestId('routing-counter-name-0')).not.toHaveTextContent('Counter 1');
    // Both rows default to FIFO_GLOBAL, so the short label appears twice.
    expect(screen.getAllByText(PRIORITY_POLICY_LABELS.FIFO_GLOBAL)).toHaveLength(2);
    expect(screen.getByTestId('routing-categories-0')).toHaveTextContent(
      'Customer Service, Kasir & Pembayaran',
    );

    // Row 2: empty name falls back to `Counter 2`, empty categories show the hint.
    expect(screen.getByTestId('routing-counter-name-1')).toHaveTextContent('Counter 2');
    expect(screen.getByTestId('routing-categories-1')).toHaveTextContent('tidak ada kategori');
  });

  it('Edit click opens the modal (autofocus on the name input), Simpan calls onUpdate with the patch and closes the modal, Batal closes without calling onUpdate', async () => {
    const onUpdate = vi.fn();
    render(
      <CounterRoutingEditor
        routingRules={[makeRule({ counterName: 'Counter 1' })]}
        categories={CATEGORIES}
        onUpdate={onUpdate}
        idPrefix="routing"
      />,
    );

    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const nameInput = screen.getByLabelText('Counter 1 nama');
    // Modal open — the name input is autofocused.
    expect(nameInput).toHaveFocus();

    // Simpan with no edits still calls onUpdate with the (unchanged) patch.
    await userEvent.click(screen.getByTestId('routing-modal-save'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(0, {
      counterName: 'Counter 1',
      priorityPolicy: 'FIFO_GLOBAL',
      assignedCategoryCodes: [],
    });
    // Modal closed — name input no longer in the document.
    expect(screen.queryByLabelText('Counter 1 nama')).not.toBeInTheDocument();
  });

  it('Batal closes the modal without calling onUpdate', async () => {
    const onUpdate = vi.fn();
    render(
      <CounterRoutingEditor
        routingRules={[makeRule()]}
        categories={CATEGORIES}
        onUpdate={onUpdate}
        idPrefix="routing"
      />,
    );

    await userEvent.click(screen.getByTestId('routing-edit-0'));
    await userEvent.type(screen.getByLabelText('Counter 1 nama'), 'Sementara');
    await userEvent.click(screen.getByText('Batal'));

    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Counter 1 nama')).not.toBeInTheDocument();
  });

  it('SearchableCategorySelect inside the modal toggles a category code into the saved patch', async () => {
    const onUpdate = vi.fn();
    render(
      <CounterRoutingEditor
        routingRules={[makeRule()]}
        categories={CATEGORIES}
        onUpdate={onUpdate}
        idPrefix="routing"
      />,
    );

    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const search = screen.getByRole('combobox', { name: /Kategori dilayani/ });
    await userEvent.type(search, 'Customer');
    await userEvent.click(screen.getByRole('option', { name: /Customer Service/ }));
    await userEvent.click(screen.getByTestId('routing-modal-save'));

    expect(onUpdate).toHaveBeenCalledWith(0, expect.objectContaining({ assignedCategoryCodes: ['A'] }));
  });

  it('Priority select changes the routing-priority-desc hint text (mirrors wizard)', async () => {
    render(
      <CounterRoutingEditor
        routingRules={[makeRule()]}
        categories={CATEGORIES}
        onUpdate={() => {}}
        idPrefix="routing"
      />,
    );

    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const desc = await screen.findByTestId('routing-priority-desc');
    // Default FIFO_GLOBAL → its description.
    expect(desc).toHaveTextContent(/urutan masuk/i);

    // Switch to CATEGORY_PRIORITY → the description hint follows the pick.
    await userEvent.selectOptions(screen.getByLabelText('Counter 1 kebijakan prioritas'), 'CATEGORY_PRIORITY');
    expect(desc).toHaveTextContent(/prioritas lebih tinggi/i);
  });

  it('Focus returns to the Edit button on Batal (WCAG 2.4.3)', async () => {
    render(
      <CounterRoutingEditor
        routingRules={[makeRule()]}
        categories={CATEGORIES}
        onUpdate={() => {}}
        idPrefix="routing"
      />,
    );

    const editBtn = screen.getByTestId('routing-edit-0');
    await userEvent.click(editBtn);
    expect(screen.getByLabelText('Counter 1 nama')).toHaveFocus();
    await userEvent.click(screen.getByText('Batal'));
    await waitFor(() => expect(editBtn).toHaveFocus());
  });

  it('Focus returns to the Edit button on Escape (WCAG 2.4.3)', async () => {
    render(
      <CounterRoutingEditor
        routingRules={[makeRule()]}
        categories={CATEGORIES}
        onUpdate={() => {}}
        idPrefix="routing"
      />,
    );

    const editBtn = screen.getByTestId('routing-edit-0');
    await userEvent.click(editBtn);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(editBtn).toHaveFocus());
  });

  it('Overlay click (target === currentTarget) closes the modal and returns focus to the Edit button (WCAG 2.4.3)', async () => {
    const { container } = render(
      <CounterRoutingEditor
        routingRules={[makeRule()]}
        categories={CATEGORIES}
        onUpdate={() => {}}
        idPrefix="routing"
      />,
    );

    const editBtn = screen.getByTestId('routing-edit-0');
    await userEvent.click(editBtn);
    expect(screen.getByLabelText('Counter 1 nama')).toHaveFocus();

    // Click directly on the overlay div (e.target === e.currentTarget path).
    const overlay = container.querySelector('.modal__overlay') as HTMLElement;
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay);

    // Modal unmounted — name input no longer in the document.
    expect(screen.queryByLabelText('Counter 1 nama')).not.toBeInTheDocument();
    // Focus returned to the Edit trigger.
    await waitFor(() => expect(editBtn).toHaveFocus());
  });

  it('discarded draft does not leak into a different row on re-open (modal unmount-remount + `key={editingIndex}`)', async () => {
    const rules: RoutingRuleRow[] = [
      makeRule({ counterId: 1, counterName: 'Loket A' }),
      makeRule({ counterId: 2, counterName: 'Loket B' }),
    ];
    render(
      <CounterRoutingEditor
        routingRules={rules}
        categories={CATEGORIES}
        onUpdate={() => {}}
        idPrefix="routing"
      />,
    );

    // Open row 0's Edit modal, type a throwaway name, then Batal (discard).
    await userEvent.click(screen.getByTestId('routing-edit-0'));
    await userEvent.type(screen.getByLabelText('Counter 1 nama'), 'Sementara');
    await userEvent.click(screen.getByText('Batal'));
    expect(screen.queryByLabelText('Counter 1 nama')).not.toBeInTheDocument();

    // Open row 1's Edit modal — its name input shows row 1's original name,
    // NOT 'Sementara'. The discard is produced by the modal unmounting (Batal
    // sets editingIndex = null) then re-mounting for row 1; `key={editingIndex}`
    // is belt-and-suspenders that also re-seeds if a future affordance ever
    // switches rows without closing first (the overlay blocks the table today).
    await userEvent.click(screen.getByTestId('routing-edit-1'));
    const row1Name = screen.getByLabelText('Counter 2 nama');
    expect(row1Name).toHaveValue('Loket B');
    expect(row1Name).not.toHaveValue('Sementara');

    // Re-open row 0 — also shows its original name (no leak in either direction).
    await userEvent.click(screen.getByText('Batal'));
    await userEvent.click(screen.getByTestId('routing-edit-0'));
    expect(screen.getByLabelText('Counter 1 nama')).toHaveValue('Loket A');
    expect(screen.getByLabelText('Counter 1 nama')).not.toHaveValue('Sementara');
  });

  it('onAdd provided → renders "+ Tambah Counter"; clicking calls onAdd. undefined → no Add button', async () => {
    const onAdd = vi.fn();
    const { rerender } = render(
      <CounterRoutingEditor
        routingRules={[makeRule()]}
        categories={CATEGORIES}
        onUpdate={() => {}}
        onAdd={onAdd}
        idPrefix="routing"
      />,
    );
    const addBtn = screen.getByRole('button', { name: '+ Tambah Counter' });
    await userEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledTimes(1);

    // Re-render without onAdd — no Add button.
    rerender(
      <CounterRoutingEditor
        routingRules={[makeRule()]}
        categories={CATEGORIES}
        onUpdate={() => {}}
        idPrefix="routing"
      />,
    );
    expect(screen.queryByRole('button', { name: '+ Tambah Counter' })).not.toBeInTheDocument();
  });

  it('onRemove provided → renders "Hapus"; clicking calls onRemove(i). canRemove false → Hapus disabled. undefined → no Hapus', async () => {
    const onRemove = vi.fn();
    const rules: RoutingRuleRow[] = [
      makeRule({ counterId: 1 }),
      makeRule({ counterId: 2 }),
    ];
    const { rerender } = render(
      <CounterRoutingEditor
        routingRules={rules}
        categories={CATEGORIES}
        onUpdate={() => {}}
        onRemove={onRemove}
        canRemove={() => rules.length > 1}
        idPrefix="routing"
      />,
    );

    // Two Hapus buttons rendered — clicking the second calls onRemove(1).
    const hapusBtns = screen.getAllByRole('button', { name: 'Hapus' });
    expect(hapusBtns).toHaveLength(2);
    await userEvent.click(hapusBtns[1]);
    expect(onRemove).toHaveBeenCalledWith(1);

    // canRemove returning false → all Hapus disabled.
    rerender(
      <CounterRoutingEditor
        routingRules={rules}
        categories={CATEGORIES}
        onUpdate={() => {}}
        onRemove={onRemove}
        canRemove={() => false}
        idPrefix="routing"
      />,
    );
    for (const btn of screen.getAllByRole('button', { name: 'Hapus' })) {
      expect(btn).toBeDisabled();
    }

    // Re-render without onRemove — no Hapus buttons.
    rerender(
      <CounterRoutingEditor
        routingRules={rules}
        categories={CATEGORIES}
        onUpdate={() => {}}
        idPrefix="routing"
      />,
    );
    expect(screen.queryAllByRole('button', { name: 'Hapus' })).toHaveLength(0);
  });

  it('Info glyph carries the priority description as title + aria-label', () => {
    render(
      <CounterRoutingEditor
        routingRules={[makeRule({ priorityPolicy: 'FIFO_GLOBAL' })]}
        categories={CATEGORIES}
        onUpdate={() => {}}
        idPrefix="routing"
      />,
    );

    const fifoInfo = screen.getByRole('img', {
      name: `Keterangan: ${PRIORITY_POLICY_DESCRIPTIONS.FIFO_GLOBAL}`,
    });
    expect(fifoInfo).toBeInTheDocument();
    expect(fifoInfo).toHaveAttribute('title', PRIORITY_POLICY_DESCRIPTIONS.FIFO_GLOBAL);
  });
});