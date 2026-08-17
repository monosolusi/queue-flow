import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StateMachineSource } from './StateMachineSource';
import { defaultStateMachineForm, type StateMachineForm, type Transition } from '../lib/state-machine';

/**
 * Isolated presentational tests for the JSON Sumber view — the connector legend
 * (the "indikator konektor" from → to the manager asked for) and the read-only
 * textarea affordance. No router, no draft, no parsing — `StateMachineSource`
 * is a presentational projection of the form (the designer page derives the
 * text), so these tests drive it with raw props the way the designer does.
 * Mirrors the `css:false`-jsdom convention (assert via roles / text /
 * attributes, never computed style).
 */

const DEFAULT_CONNECTORS: Transition[] = [
  { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya', requeuePolicy: { kind: 'KEEP' } },
  { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani', requeuePolicy: { kind: 'KEEP' } },
  { from: 'CALLING', to: 'SKIPPED', actionLabel: 'Lewati / Absen', requeuePolicy: { kind: 'KEEP' } },
  { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang', requeuePolicy: { kind: 'KEEP' } },
  { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan', requeuePolicy: { kind: 'KEEP' } },];

/** The default PRD §7 form, optionally re-routed for the sides cases. */
function formWith(transitions: Transition[] = DEFAULT_CONNECTORS): StateMachineForm {
  return { ...defaultStateMachineForm(), transitions };
}

/** What the component should render for `formWith()` — the form minus `mode`. */
function expectedJson(form: StateMachineForm): string {
  const { mode: _mode, ...graph } = form;
  return JSON.stringify(graph, null, 2);
}

describe('StateMachineSource (JSON Sumber view)', () => {
  it('renders the read-only JSON label for the textarea', () => {
    render(<StateMachineSource stateMachine={formWith()} />);
    expect(screen.getByText('Sumber JSON alur status (baca saja)')).toBeInTheDocument();
    // The label is wired to the textarea (htmlFor/id) — the reason this stays a
    // <textarea> rather than a <pre>.
    expect(screen.getByLabelText('Sumber JSON alur status (baca saja)')).toBe(
      screen.getByTestId('sm-source'),
    );
  });

  it('renders the form as pretty-printed JSON', () => {
    const form = formWith();
    render(<StateMachineSource stateMachine={form} />);
    expect((screen.getByTestId('sm-source') as HTMLTextAreaElement).value).toBe(expectedJson(form));
  });

  it('strips the client-only `mode` preset from the projected text', () => {
    // `mode` is an internal 'default' | 'custom' marker that never reaches
    // core-api (`toStateMachineDto` drops it). Showing it would put an internal
    // enum in front of the manager and imply the flow carries a field it does
    // not. Everything else on the form stays — this view is for reading the
    // flow being composed, not for previewing the wire payload.
    render(<StateMachineSource stateMachine={formWith()} />);
    const parsed = JSON.parse((screen.getByTestId('sm-source') as HTMLTextAreaElement).value);
    expect(parsed.mode).toBeUndefined();
    expect(parsed.states).toEqual(formWith().states);
    expect(parsed.transitions).toHaveLength(DEFAULT_CONNECTORS.length);
    // The sibling wire-field facets are part of the flow the manager sees.
    expect(parsed).toHaveProperty('positions');
    expect(parsed).toHaveProperty('nodeActions');
    expect(parsed).toHaveProperty('terminalNodes');
    expect(parsed).toHaveProperty('endSources');
    expect(parsed).toHaveProperty('startSources');
  });

  it('is read-only, not disabled (still focusable + selectable for copy)', () => {
    // `readOnly` keeps the text reachable by keyboard and AT — a `disabled`
    // textarea is skipped by the tab order, which would defeat the one job this
    // view has (read + copy the whole flow).
    render(<StateMachineSource stateMachine={formWith()} />);
    const textarea = screen.getByTestId('sm-source') as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute('readonly');
    expect(textarea).not.toBeDisabled();
    textarea.focus();
    expect(textarea).toHaveFocus();
  });

  it('does not accept typed edits — the flow has one editing surface, the canvas', async () => {
    // The single-source-of-truth behaviour, driven through the real keyboard
    // path (`userEvent.type` honours `readOnly` and fires no input events),
    // rather than `fireEvent.change`, which assigns the DOM value directly —
    // something `readOnly` does not gate at all.
    //
    // Mutation-tested: deleting `readOnly` does NOT redden this test, because
    // the value is also held by React (a controlled textarea with no `onChange`
    // snaps back either way). The load-bearing guard for the attribute is the
    // `toHaveAttribute('readonly')` assertion above, which DOES redden. This
    // test covers the manager-visible behaviour on top of it.
    const form = formWith();
    render(<StateMachineSource stateMachine={form} />);
    const textarea = screen.getByTestId('sm-source') as HTMLTextAreaElement;
    // Plain text on purpose — `userEvent.type` reads `{`/`[` as key descriptors.
    await userEvent.type(textarea, 'HACKED');
    expect((screen.getByTestId('sm-source') as HTMLTextAreaElement).value).toBe(expectedJson(form));
  });

  it('points the textarea at the hint so AT users hear where editing lives', () => {
    // A sighted manager reads the hint above the field; a screen-reader user who
    // tabs straight into the textarea would otherwise hear only the name + "read
    // only" and no route to the Diagram view.
    render(<StateMachineSource stateMachine={formWith()} />);
    expect(screen.getByTestId('sm-source')).toHaveAttribute('aria-describedby', 'sm-source-hint');
    expect(document.getElementById('sm-source-hint')).toHaveClass('sm-source__hint');
  });

  it('renders no error region (nothing here parses, so nothing here can fail)', () => {
    render(<StateMachineSource stateMachine={formWith()} />);
    expect(screen.queryByTestId('sm-source-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('sm-source')).not.toHaveAttribute('aria-invalid');
  });

  it('explains in the hint that editing happens in the Diagram view', () => {
    // The pane is read-only, so the copy has to say where the edit affordance
    // actually is — otherwise the manager reads it as a broken field.
    render(<StateMachineSource stateMachine={formWith()} />);
    const hint = document.querySelector('.sm-source__hint');
    expect(hint).not.toBeNull();
    const text = hint!.textContent ?? '';
    expect(text).toContain('tidak bisa diubah di sini');
    expect(text).toContain('Diagram');
    // The former Kaleo/XML vocabulary is gone.
    expect(text).not.toContain('Kaleo');
    expect(text).not.toContain('XML');
  });

  it('renders one connector chip per transition with from, arrow, to, and label', () => {
    render(<StateMachineSource stateMachine={formWith()} />);
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
    render(<StateMachineSource stateMachine={formWith()} />);
    const first = screen.getAllByTestId('sm-source-connector')[0];
    const srOnlySpans = first.querySelectorAll('.sr-only');
    expect(srOnlySpans).toHaveLength(2);
    expect(srOnlySpans[0].textContent).toMatch(/^\s*ke\s*$/);
    expect(srOnlySpans[1].textContent).toMatch(/^\s*aksi:\s*$/);
  });

  it('labels the connector list with a from→to description for AT', () => {
    render(<StateMachineSource stateMachine={formWith()} />);
    expect(screen.getByTestId('sm-source-connectors')).toHaveAttribute(
      'aria-label',
      'Daftar konektor transisi (dari titik asal ke titik tujuan)',
    );
  });

  it('renders an empty list when there are no connectors (still mounted, no chips)', () => {
    render(<StateMachineSource stateMachine={formWith([])} />);
    expect(screen.getByTestId('sm-source-connectors')).toBeInTheDocument();
    expect(screen.queryAllByTestId('sm-source-connector')).toHaveLength(0);
  });

  it('shows the connection sides in the connector legend for a non-default-routed edge', () => {
    // Manager feedback: the source didn't say which point connects to which.
    // The legend appends `sourceSide→targetSide` when the edge uses a
    // non-default connection point, so the routing is visible alongside the
    // from→to direction.
    const connectors: Transition[] = [
      { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang', requeuePolicy: { kind: 'KEEP' }, sourceSide: 'bottom', targetSide: 'top' },    ];
    render(<StateMachineSource stateMachine={formWith(connectors)} />);
    const sides = screen.getByTestId('sm-source-connector-sides');
    expect(sides).toHaveTextContent('bottom→top');
  });

  it('hides the connection sides segment for a default-routed edge', () => {
    // A default edge (right→left) omits the sides segment — the legend stays
    // concise and the default routing is not noise.
    render(<StateMachineSource stateMachine={formWith()} />);
    expect(screen.queryAllByTestId('sm-source-connector-sides')).toHaveLength(0);
  });
});
