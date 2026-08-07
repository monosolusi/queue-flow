import { DEFAULT_STATE_MACHINE, type StateMachineDto } from '../api/types';

/** One transition edge in the editable state machine. */
export interface Transition {
  from: string;
  to: string;
  actionLabel: string;
}

/**
 * The editable state-machine form slice. `mode` is a **client-only preset** —
 * it is never sent to core-api (the PUT payload is always the full
 * `{ states, transitions }` graph). `'default'` locks the form to the PRD §7
 * default graph; `'custom'` opens the states + transitions editor. It is
 * inferred on prefill (deep-equal to {@link DEFAULT_STATE_MACHINE} ⇒ default)
 * so a re-edit of a store that never customized stays in default mode.
 */
export interface StateMachineForm {
  mode: 'default' | 'custom';
  states: string[];
  transitions: Transition[];
}

/** The PRD §7 default graph prefilled into the editor's default mode. */
export function defaultStateMachineForm(): StateMachineForm {
  return {
    mode: 'default',
    states: [...DEFAULT_STATE_MACHINE.states],
    transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
  };
}

/** Structural deep-equal against the PRD §7 default graph (prefill mode inference). */
export function isDefaultGraph(states: readonly string[], transitions: readonly Transition[]): boolean {
  if (states.length !== DEFAULT_STATE_MACHINE.states.length) return false;
  if (transitions.length !== DEFAULT_STATE_MACHINE.transitions.length) return false;
  const sameStates = states.every((s, i) => s === DEFAULT_STATE_MACHINE.states[i]);
  if (!sameStates) return false;
  return transitions.every((t, i) => {
    const d = DEFAULT_STATE_MACHINE.transitions[i];
    return t.from === d.from && t.to === d.to && t.actionLabel === d.actionLabel;
  });
}

/**
 * Maps the editable form onto the `PUT /api/system/config` wire shape — the one
 * place that owns "strip the client-only `mode` **and** force the PRD §7 default
 * graph in default mode".
 *
 * The force-reset is not redundant with the editor's default-radio (which today
 * calls {@link defaultStateMachineForm} and so already replaces the graph): if
 * that radio ever preserved the graph and only flipped `mode`, a half-edited
 * custom graph the manager abandoned would silently ship AS the default — the
 * exact leak the "client-only preset stripped at finalize" rule exists to
 * prevent. Both the wizard's `finalize()` and the panel's `save()` go through
 * here so neither surface can drift from the other's defense.
 */
export function toStateMachineDto(form: StateMachineForm): StateMachineDto {
  return form.mode === 'default'
    ? {
        states: [...DEFAULT_STATE_MACHINE.states],
        transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
      }
    : { states: form.states, transitions: form.transitions };
}

/**
 * Validate a custom state machine, mirroring the backend invariants
 * (`StateMachine` / `StateSchema` in `core-api`) so the editor never submits a
 * graph the backend would reject with a 400. Returns a list of human-readable
 * (Indonesian) error strings; empty means valid.
 *
 * The copy says "status" / "alur status", never the internal "state" /
 * "state machine" — the editor now lives on `/config`, a surface a
 * non-technical store manager uses daily (CLAUDE.md: user-visible text must
 * never leak internal terms).
 */
export function validateCustomStateMachine(form: StateMachineForm): string[] {
  const errors: string[] = [];
  const { states, transitions } = form;
  if (states.length === 0) errors.push('Alur status harus memiliki minimal satu status.');
  if (transitions.length === 0) errors.push('Alur status harus memiliki minimal satu transisi.');
  const seenStates = new Set<string>();
  for (const s of states) {
    if (!s || !s.trim()) errors.push('Nama status tidak boleh kosong.');
    else if (seenStates.has(s)) errors.push(`Status '${s}' duplikat.`);
    seenStates.add(s);
  }
  const seenEdges = new Set<string>();
  for (const t of transitions) {
    if (!t.actionLabel || !t.actionLabel.trim()) errors.push('Label aksi tidak boleh kosong.');
    if (!seenStates.has(t.from)) errors.push(`Transisi '${t.from}'→'${t.to}': status '${t.from}' tidak dikenal.`);
    if (!seenStates.has(t.to)) errors.push(`Transisi '${t.from}'→'${t.to}': status '${t.to}' tidak dikenal.`);
    const edge = `${t.from}->${t.to}`;
    if (seenEdges.has(edge)) errors.push(`Transisi '${t.from}'→'${t.to}' duplikat.`);
    seenEdges.add(edge);
  }
  // De-duplicate identical messages (e.g. several empty labels).
  return [...new Set(errors)];
}

/**
 * What each status of the standard (PRD §7) flow powers, in manager-facing
 * Indonesian. Keyed by the status names in {@link DEFAULT_STATE_MACHINE}; the
 * copy names the caller BUTTON (or the report metric) that stops working, never
 * the backend mechanism, because the reader is a non-technical store manager.
 */
const CANONICAL_STATE_CONSEQUENCES: Record<string, string> = {
  WAITING:
    'tiket baru dari kiosk selalu dibuat di status ini, jadi tanpa status ini tiket tidak pernah bisa dipanggil',
  CALLING: 'tombol "Panggil Berikutnya" di panel caller berhenti berfungsi',
  SERVING: 'tombol "Mulai Melayani" di panel caller berhenti berfungsi',
  SKIPPED: 'tombol "Lewati / Absen" dan "Panggil Ulang" di panel caller berhenti berfungsi',
  COMPLETED: 'tombol "Selesai Layan" berhenti berfungsi dan lama layanan tidak tercatat di laporan',
};

/** One status of the standard flow that the edited graph no longer contains. */
export interface MissingCanonicalState {
  /** The status name as it appears in the standard flow (e.g. `COMPLETED`). */
  readonly state: string;
  /** What stops working without it, in manager-facing Indonesian. */
  readonly consequence: string;
}

/**
 * Statuses of the standard flow that the edited graph dropped.
 *
 * **This is a WARNING source, not a validation rule** — deliberately NOT part of
 * {@link validateCustomStateMachine} and deliberately not a save/Lanjut gate. The
 * backend accepts any well-formed graph (`StateSchema` enforces only non-empty /
 * unique / at-least-one; it carries no invariant that the standard statuses
 * survive) and a custom flow may legitimately skip one, so blocking would
 * over-restrict. But core-api's queue engine transitions to these status names
 * as literals — `complete()` writes `COMPLETED` and stamps `completed_at`, the
 * dedicated caller endpoints own those side effects — so dropping one silently
 * breaks that part of the queue for every FUTURE ticket, not just the live ones
 * the panel's other warning covers. The manager has to be told; the decision
 * stays theirs.
 *
 * Default mode always ships the standard graph verbatim ({@link toStateMachineDto}
 * force-resets it), so nothing can be missing there.
 */
export function missingCanonicalStates(form: StateMachineForm): MissingCanonicalState[] {
  if (form.mode === 'default') return [];
  const present = new Set(form.states.map((s) => s.trim()));
  return DEFAULT_STATE_MACHINE.states
    .filter((state) => !present.has(state))
    .map((state) => ({ state, consequence: CANONICAL_STATE_CONSEQUENCES[state] ?? '' }));
}

/** States referenced by at least one transition — removing these would dangle an edge. */
export function referencedStates(form: StateMachineForm): Set<string> {
  const refs = new Set<string>();
  for (const t of form.transitions) {
    refs.add(t.from);
    refs.add(t.to);
  }
  return refs;
}

// --- form mutation helpers (pure over the StateMachineForm slice) ------------

export function updateTransition(
  form: StateMachineForm,
  i: number,
  patch: Partial<{ from: string; to: string; actionLabel: string }>,
): StateMachineForm {
  const transitions = form.transitions.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
  return { ...form, transitions };
}

export function addTransition(form: StateMachineForm): StateMachineForm {
  // Seed a new edge from the first state to itself (or empty when no states yet)
  // so the dropdowns always carry a valid value; the manager adjusts from there.
  const firstState = form.states[0] ?? '';
  return {
    ...form,
    transitions: [...form.transitions, { from: firstState, to: firstState, actionLabel: '' }],
  };
}

export function removeTransition(form: StateMachineForm, i: number): StateMachineForm {
  return { ...form, transitions: form.transitions.filter((_, idx) => idx !== i) };
}

export function updateState(form: StateMachineForm, i: number, value: string): StateMachineForm {
  const states = form.states.map((s, idx) => (idx === i ? value : s));
  // Renaming a state must propagate to any transition that referenced the old
  // name, so a rename never leaves a dangling edge (the dropdowns would then
  // show the old value which is no longer in the states list).
  const oldName = form.states[i];
  const transitions = form.transitions.map((t) => ({
    from: t.from === oldName ? value : t.from,
    to: t.to === oldName ? value : t.to,
    actionLabel: t.actionLabel,
  }));
  return { ...form, states, transitions };
}

export function addState(form: StateMachineForm): StateMachineForm {
  return { ...form, states: [...form.states, ''] };
}

export function removeState(form: StateMachineForm, i: number): StateMachineForm {
  return { ...form, states: form.states.filter((_, idx) => idx !== i) };
}