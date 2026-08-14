import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StateMachineSource } from './StateMachineSource';
import type { Transition } from '../lib/state-machine';

/**
 * Isolated presentational tests for the XML Source view — the connector legend
 * (the "indikator konektor" from → to the manager asked for), the textarea
 * affordance, and the inline error region. No router, no draft, no parsing —
 * `StateMachineSource` is a controlled presentational component (the designer
 * page owns parsing), so these tests drive it with raw props the way the
 * designer does. Mirrors the `css:false`-jsdom convention (assert via roles /
 * text / attributes, never computed style).
 */

const DEFAULT_CONNECTORS: Transition[] = [
  { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
  { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
  { from: 'CALLING', to: 'SKIPPED', actionLabel: 'Lewati / Absen' },
  { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang' },
  { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan' },
];

describe('StateMachineSource (XML Source view)', () => {
  it('renders the "Sumber XML alur status" label for the textarea', () => {
    render(
      <StateMachineSource
        sourceText='<?xml version="1.0"?><stateMachine/>'
        onSourceChange={() => {}}
        error={null}
        connectors={DEFAULT_CONNECTORS}
      />,
    );
    expect(screen.getByText('Sumber XML alur status')).toBeInTheDocument();
  });

  it('explains the Kaleo shape in the hint (which element is a status, where a transition lives)', () => {
    // The format changed from the former QMS-custom `<stateMachine>` shape to a
    // Liferay Kaleo `<workflow-definition>`, so the manager-facing hint has to
    // explain the new one: a status is a <task> or a <state>, a transition is
    // nested inside its SOURCE status, and everything Kaleo has no slot for
    // rides <metadata>. SME-friendly Indonesian — no XPath, no jargon.
    render(
      <StateMachineSource
        sourceText='<?xml version="1.0"?><workflow-definition/>'
        onSourceChange={() => {}}
        error={null}
        connectors={DEFAULT_CONNECTORS}
      />,
    );
    const hint = document.querySelector('.sm-source__hint');
    expect(hint).not.toBeNull();
    const text = hint!.textContent ?? '';
    expect(text).toContain('Liferay Kaleo');
    expect(text).toContain('<workflow-definition>');
    expect(text).toContain('<task>');
    expect(text).toContain('<state>');
    expect(text).toContain('<target>');
    expect(text).toContain('<metadata>');
    // The load-bearing fact: the label IS the Caller's button text.
    expect(text).toContain('layar petugas');
    // The former shape's vocabulary is gone.
    expect(text).not.toContain('actionLabel');
    expect(text).not.toContain('stateMachine');
  });
  it('renders one connector chip per transition with from, arrow, to, and label', () => {
    render(
      <StateMachineSource
        sourceText="{}"
        onSourceChange={() => {}}
        error={null}
        connectors={DEFAULT_CONNECTORS}
      />,
    );
    const list = screen.getByTestId('sm-source-connectors');
    expect(list).toBeInTheDocument();
    // A connector chip per transition.
    expect(screen.getAllByTestId('sm-source-connector')).toHaveLength(DEFAULT_CONNECTORS.length);
    // The first connector shows from → to · actionLabel.
    const first = screen.getAllByTestId('sm-source-connector')[0];
    expect(first).toHaveTextContent('WAITING');
    expect(first).toHaveTextContent('CALLING');
    expect(first).toHaveTextContent('Panggil Berikutnya');
    // The arrow glyph is present and decorative (AT does not announce "→").
    const arrow = first.querySelector('.sm-source-connector__arrow');
    expect(arrow).not.toBeNull();
    expect(arrow).toHaveAttribute('aria-hidden', 'true');
    expect(arrow?.textContent).toBe('→');
  });

  it('keeps the connector direction AT-readable via sr-only bridge words', () => {
    // Without the sr-only bridges, a screen reader announces "rightwards arrow"
    // for the glyph and runs the from/to/label together. The "ke" word sits
    // between from and to (AT reads "WAITING ke CALLING") and the "aksi:" word
    // sits before the label (AT reads "aksi: Panggil Berikutnya") — so the full
    // announcement is "WAITING ke CALLING aksi: Panggil Berikutnya".
    render(
      <StateMachineSource
        sourceText="{}"
        onSourceChange={() => {}}
        error={null}
        connectors={DEFAULT_CONNECTORS}
      />,
    );
    const first = screen.getAllByTestId('sm-source-connector')[0];
    const srOnlySpans = first.querySelectorAll('.sr-only');
    expect(srOnlySpans).toHaveLength(2);
    expect(srOnlySpans[0].textContent).toMatch(/^\s*ke\s*$/);
    expect(srOnlySpans[1].textContent).toMatch(/^\s*aksi:\s*$/);
  });

  it('labels the connector list with a from→to description for AT', () => {
    render(
      <StateMachineSource
        sourceText="{}"
        onSourceChange={() => {}}
        error={null}
        connectors={DEFAULT_CONNECTORS}
      />,
    );
    expect(screen.getByTestId('sm-source-connectors')).toHaveAttribute(
      'aria-label',
      'Daftar konektor transisi (dari titik asal ke titik tujuan)',
    );
  });

  it('renders an empty list when there are no connectors (still mounted, no chips)', () => {
    render(
      <StateMachineSource
        sourceText="{}"
        onSourceChange={() => {}}
        error={null}
        connectors={[]}
      />,
    );
    expect(screen.getByTestId('sm-source-connectors')).toBeInTheDocument();
    expect(screen.queryAllByTestId('sm-source-connector')).toHaveLength(0);
  });

  it('forwards textarea edits via onSourceChange (controlled, no parsing here)', () => {
    const onChange = vi.fn();
    render(
      <StateMachineSource
        sourceText='{"states":["A"]}'
        onSourceChange={onChange}
        error={null}
        connectors={DEFAULT_CONNECTORS}
      />,
    );
    const textarea = screen.getByTestId('sm-source') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"states":["A","B"]}' } });
    expect(onChange).toHaveBeenCalledWith('{"states":["A","B"]}');
  });

  it('renders the inline error region and marks the textarea invalid when error is set', () => {
    render(
      <StateMachineSource
        sourceText='<not-xml'
        onSourceChange={() => {}}
        error="XML tidak valid: kesalahan parse"
        connectors={DEFAULT_CONNECTORS}
      />,
    );
    const errorRegion = screen.getByTestId('sm-source-error');
    expect(errorRegion).toBeInTheDocument();
    expect(errorRegion).toHaveAttribute('role', 'alert');
    const textarea = screen.getByTestId('sm-source') as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    // The connector legend stays at the last-valid graph (does NOT clear) —
    // the error region explains the divergence, the legend is not re-parsed.
    expect(screen.getAllByTestId('sm-source-connector')).toHaveLength(DEFAULT_CONNECTORS.length);
  });

  it('does not mark the textarea invalid when error is null', () => {
    render(
      <StateMachineSource
        sourceText='{"states":["A"]}'
        onSourceChange={() => {}}
        error={null}
        connectors={DEFAULT_CONNECTORS}
      />,
    );
    expect(screen.queryByTestId('sm-source-error')).not.toBeInTheDocument();
    const textarea = screen.getByTestId('sm-source') as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows the connection sides in the connector legend for a non-default-routed edge', () => {
    // Manager feedback: the source didn't say which point connects to which.
    // The legend now appends `sourceSide→targetSide` when the edge uses a
    // non-default connection point, so the routing is visible alongside the
    // from→to direction.
    const connectors: Transition[] = [
      { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang', sourceSide: 'bottom', targetSide: 'top' },
    ];
    render(
      <StateMachineSource
        sourceText="{}"
        onSourceChange={() => {}}
        error={null}
        connectors={connectors}
      />,
    );
    const sides = screen.getByTestId('sm-source-connector-sides');
    expect(sides).toHaveTextContent('bottom→top');
  });

  it('hides the connection sides segment for a default-routed edge', () => {
    // A default edge (right→left) omits the sides segment — the legend stays
    // concise and the default routing is not noise.
    render(
      <StateMachineSource
        sourceText="{}"
        onSourceChange={() => {}}
        error={null}
        connectors={DEFAULT_CONNECTORS}
      />,
    );
    expect(screen.queryAllByTestId('sm-source-connector-sides')).toHaveLength(0);
  });
});