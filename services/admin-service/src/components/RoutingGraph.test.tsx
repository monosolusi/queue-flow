import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoutingGraph } from './RoutingGraph';

const CATEGORIES = [
  { code: 'A', name: 'Customer Service' },
  { code: 'B', name: 'Kasir & Pembayaran' },
  { code: 'C', name: 'Farmasi' },
];

describe('RoutingGraph', () => {
  it('renders a counter node and a referenced category node by name', () => {
    const { container } = render(
      <RoutingGraph
        routingRules={[{ counterName: 'Loket 1', assignedCategoryCodes: ['A'] }]}
        categories={CATEGORIES}
      />,
    );
    const labels = container.querySelectorAll('text.routing-graph__node-label');
    const texts = Array.from(labels).map((t) => t.textContent);
    expect(texts).toContain('Loket 1');
    expect(texts).toContain('Customer Service');
    // Category codes must never be the visible label.
    expect(texts).not.toContain('A');
  });

  it('draws one <line> edge per assigned category across all rules', () => {
    const { container } = render(
      <RoutingGraph
        routingRules={[
          { counterName: 'Loket 1', assignedCategoryCodes: ['A', 'B'] },
          { counterName: 'Loket 2', assignedCategoryCodes: ['A'] },
        ]}
        categories={CATEGORIES}
      />,
    );
    const lines = container.querySelectorAll('line.routing-graph__edge');
    expect(lines).toHaveLength(3);
  });

  it('gives each edge a <title> "{counter} → {category name}"', () => {
    const { container } = render(
      <RoutingGraph
        routingRules={[{ counterName: 'Loket 1', assignedCategoryCodes: ['A'] }]}
        categories={CATEGORIES}
      />,
    );
    const title = container.querySelector('line.routing-graph__edge title');
    expect(title?.textContent).toBe('Loket 1 → Customer Service');
  });

  it('exposes the summary via the svg aria-label and the review-routing testid', () => {
    render(
      <RoutingGraph
        routingRules={[
          { counterName: 'Loket 1', assignedCategoryCodes: ['A'] },
          { counterName: 'Loket 2', assignedCategoryCodes: ['B'] },
        ]}
        categories={CATEGORIES}
      />,
    );
    expect(screen.getByTestId('review-routing')).toBeInTheDocument();
    const svg = screen.getByRole('img', { name: /Grafik routing/ });
    expect(svg).toHaveAttribute('aria-label', 'Grafik routing: 2 counter, 2 kategori');
  });

  it('draws only referenced category nodes and lists unreferenced ones in the legend', () => {
    const { container } = render(
      <RoutingGraph
        routingRules={[{ counterName: 'Loket 1', assignedCategoryCodes: ['A'] }]}
        categories={CATEGORIES}
      />,
    );
    const labels = Array.from(
      container.querySelectorAll('text.routing-graph__node-label'),
    ).map((t) => t.textContent);
    // Farmasi (C) is unreferenced → not a node, but named in the legend.
    expect(labels).not.toContain('Farmasi');
    expect(screen.getByText(/Farmasi/)).toBeInTheDocument();
  });

  it('falls back to "Counter N" when a rule has no counterName', () => {
    const { container } = render(
      <RoutingGraph
        routingRules={[{ counterName: '', assignedCategoryCodes: ['A'] }]}
        categories={CATEGORIES}
      />,
    );
    const labels = Array.from(
      container.querySelectorAll('text.routing-graph__node-label'),
    ).map((t) => t.textContent);
    expect(labels).toContain('Counter 1');
  });

  it('skips edges for stale codes whose category no longer exists', () => {
    const { container } = render(
      <RoutingGraph
        routingRules={[{ counterName: 'Loket 1', assignedCategoryCodes: ['A', 'ZZZ'] }]}
        categories={CATEGORIES}
      />,
    );
    const lines = container.querySelectorAll('line.routing-graph__edge');
    // Only the 'A' edge — 'ZZZ' is stale and dropped.
    expect(lines).toHaveLength(1);
  });
});