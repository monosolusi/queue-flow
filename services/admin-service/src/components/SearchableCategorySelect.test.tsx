import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchableCategorySelect } from './SearchableCategorySelect';

const CATEGORIES = [
  { code: 'A', name: 'Customer Service' },
  { code: 'B', name: 'Kasir & Pembayaran' },
  { code: 'C', name: 'Farmasi' },
];

describe('SearchableCategorySelect', () => {
  it('renders selected chips by category name, not code', () => {
    render(
      <SearchableCategorySelect
        categories={CATEGORIES}
        selectedCodes={['A', 'B']}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Customer Service')).toBeInTheDocument();
    expect(screen.getByText('Kasir & Pembayaran')).toBeInTheDocument();
  });

  it('shows the empty hint when nothing is selected', () => {
    render(
      <SearchableCategorySelect categories={CATEGORIES} selectedCodes={[]} onChange={() => {}} />,
    );
    expect(screen.getByText('Belum ada kategori dipilih')).toBeInTheDocument();
  });

  it('filters the listbox by name when typing', async () => {
    render(
      <SearchableCategorySelect categories={CATEGORIES} selectedCodes={[]} onChange={() => {}} />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    await userEvent.type(input, 'farm');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Farmasi');
  });

  it('toggles a category code into the selection on option click', () => {
    const onChange = vi.fn();
    render(
      <SearchableCategorySelect categories={CATEGORIES} selectedCodes={[]} onChange={onChange} />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Customer Service/ }));
    expect(onChange).toHaveBeenCalledWith(['A']);
  });

  it('removes a selected code when its option is clicked again', () => {
    const onChange = vi.fn();
    render(
      <SearchableCategorySelect categories={CATEGORIES} selectedCodes={['A']} onChange={onChange} />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Customer Service/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('removes a chip via its remove button', () => {
    const onChange = vi.fn();
    render(
      <SearchableCategorySelect categories={CATEGORIES} selectedCodes={['A', 'B']} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Hapus Customer Service/ }));
    expect(onChange).toHaveBeenCalledWith(['B']);
  });

  it('closes the dropdown on Escape and reflects aria-expanded', () => {
    render(
      <SearchableCategorySelect categories={CATEGORIES} selectedCodes={[]} onChange={() => {}} />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles the highlighted option via ArrowDown + Enter', () => {
    const onChange = vi.fn();
    render(
      <SearchableCategorySelect categories={CATEGORIES} selectedCodes={[]} onChange={onChange} />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Highlighted index is now 1 (Kasir & Pembayaran).
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['B']);
  });

  it('manual close toggle collapses the listbox (feedback: bisa ditutup manual)', () => {
    render(
      <SearchableCategorySelect categories={CATEGORIES} selectedCodes={[]} onChange={() => {}} />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    // Open — options visible.
    expect(screen.getAllByRole('option')).toHaveLength(3);
    // The dedicated toggle button is the explicit close affordance.
    const toggle = screen.getByRole('button', { name: /Tutup daftar kategori/i });
    fireEvent.click(toggle);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    // Toggling again re-opens (now labeled "Buka").
    fireEvent.click(screen.getByRole('button', { name: /Buka daftar kategori/i }));
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('caps the listbox max-height inline so a scroll container never scrolls', () => {
    // jsdom has no layout engine, so `getBoundingClientRect` returns a
    // degenerate rect that is the SAME for every element (the global test setup
    // patches it to a non-zero default, but identical across elements) — so
    // `spaceBelow`/`spaceAbove` are ≤ 0 and the measurement falls to the cramped
    // branch (downward, min-height). What matters here is that the listbox
    // carries an inline maxHeight (set from the measurement) instead of relying
    // on a CSS max-height that would extend a scroll container.
    render(
      <SearchableCategorySelect categories={CATEGORIES} selectedCodes={[]} onChange={() => {}} />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    const listbox = screen.getByRole('listbox');
    expect(listbox.style.maxHeight).toMatch(/px$/);
  });
});