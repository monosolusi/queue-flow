import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CategoryBreakdownChart } from './CategoryBreakdownChart';
import type { CategoryBreakdownDto } from '../api/types';

function cat(id: string, name: string, total: number): CategoryBreakdownDto {
  return {
    categoryId: id,
    code: name.slice(0, 1).toUpperCase(),
    categoryName: name,
    totalTickets: total,
    avgWaitTimeMs: 0,
    avgServiceTimeMs: 0,
  };
}

describe('CategoryBreakdownChart (QUE-46 / QUE-48 — per-category horizontal bars)', () => {
  it('renders one row per category, sorted by total desc, with a per-bar testid', () => {
    render(
      <CategoryBreakdownChart
        perCategory={[cat('cat-a', 'Customer Service', 3), cat('cat-b', 'Kasir', 5)]}
      />,
    );
    // Sorted desc → Kasir (5) is row 0, Customer Service (3) is row 1.
    expect(screen.getByTestId('category-breakdown-bar-0')).toBeInTheDocument();
    expect(screen.getByTestId('category-breakdown-bar-1')).toBeInTheDocument();
    expect(screen.getByTestId('category-breakdown-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('category-breakdown-row-1')).toBeInTheDocument();
  });

  it('exposes an accessible summary via role="img" + aria-label', () => {
    render(
      <CategoryBreakdownChart
        perCategory={[cat('cat-a', 'Customer Service', 3), cat('cat-b', 'Kasir', 5)]}
      />,
    );
    // Sorted desc → Kasir first in the summary.
    expect(
      screen.getByRole('img', {
        name: /Total pengunjung per kategori: Kasir: 5, Customer Service: 3/,
      }),
    ).toBeInTheDocument();
  });

  it('each row carries a <title> with the full name + count (hover/a11y channel)', () => {
    render(<CategoryBreakdownChart perCategory={[cat('cat-a', 'Loket Umum', 7)]} />);
    const row = screen.getByTestId('category-breakdown-row-0');
    expect(row.querySelector('title')?.textContent).toBe('Loket Umum: 7 pengunjung');
  });

  it('shows the full category name when it fits the label column', () => {
    const { container } = render(
      <CategoryBreakdownChart perCategory={[cat('cat-a', 'Kasir', 2)]} />,
    );
    const label = container.querySelector('.category-breakdown__label');
    expect(label?.textContent).toBe('Kasir');
  });

  it('truncates long names with an ellipsis (non-overlap budget) but keeps the full name in <title>', () => {
    const longName = 'Layanan Administrasi Kepegawaian dan Umum';
    render(<CategoryBreakdownChart perCategory={[cat('cat-a', longName, 1)]} />);
    const row = screen.getByTestId('category-breakdown-row-0');
    // The <title> always carries the full, untruncated name.
    expect(row.querySelector('title')?.textContent).toContain(longName);
    // The visible label is truncated (ends with an ellipsis).
    const label = row.querySelector('.category-breakdown__label');
    expect(label?.textContent).toMatch(/…$/);
    expect(label?.textContent?.endsWith(longName)).toBe(false);
  });

  it('renders nothing when perCategory is empty (defensive backstop)', () => {
    const { container } = render(<CategoryBreakdownChart perCategory={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('category-breakdown-chart')).not.toBeInTheDocument();
  });

  it('collapses the aria-label to a one-line summary when there are > 8 categories (a11y — wall-of-text guard)', () => {
    // A manager can configure many categories; a 20-entry aria-label is a wall
    // of text for AT. The per-row <title> stays the granular channel. Mirrors
    // the RangeTrendChart >12-day collapse precedent.
    const many = Array.from({ length: 10 }, (_, i) =>
      cat(`cat-${i}`, `Kategori ${i}`, 10 - i),
    );
    render(<CategoryBreakdownChart perCategory={many} />);
    // Sorted desc → biggest is "Kategori 0" (10). The compact summary names the
    // count + the biggest; it does NOT enumerate all 10.
    expect(
      screen.getByRole('img', {
        name: /Total pengunjung per kategori, 10 kategori\. Terbanyak: Kategori 0: 10/,
      }),
    ).toBeInTheDocument();
    // The verbose enumeration must NOT be in the accessible name.
    expect(screen.queryByRole('img', { name: /Kategori 9/ })).not.toBeInTheDocument();
  });

  it('never lets the raw category CODE surface as a visible label (QUE-49)', () => {
    render(
      <CategoryBreakdownChart
        perCategory={[cat('cat-a', 'Customer Service', 3), cat('cat-b', 'Kasir', 1)]}
      />,
    );
    // The chart surfaces names + counts only; the code is not rendered.
    const svg = screen.getByTestId('category-breakdown-chart');
    expect(svg.textContent).toContain('Customer Service');
    expect(svg.textContent).toContain('Kasir');
    // 'A'/'B' could be a coincidental substring of a name, but the visible
    // <text> labels must be the names — assert the label text nodes directly.
    const labels = svg.querySelectorAll('.category-breakdown__label');
    expect(Array.from(labels, (l) => l.textContent)).toEqual(
      expect.arrayContaining(['Customer Service', 'Kasir']),
    );
  });
});