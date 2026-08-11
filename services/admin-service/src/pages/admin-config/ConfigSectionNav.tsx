import { type KeyboardEvent } from 'react';
import { CONFIG_SECTIONS, type SectionId } from './config-sections';

/**
 * Per-section validity for the saved sections of the config panel. Each flag
 * is `true` when that section's inputs are valid; the nav renders an error
 * badge on tabs whose flag is `false`. The `manual` section has no save button
 * and so carries no validity flag here.
 */
export interface SectionValidity {
  readonly profile: boolean;
  readonly categories: boolean;
  readonly routing: boolean;
  readonly dailyReset: boolean;
  readonly stateMachine: boolean;
}

interface ConfigSectionNavProps {
  /** The currently-active section (controls `aria-selected`/`tabindex` roving). */
  readonly active: SectionId;
  /** Switches the active section (called on click + auto-activating arrow keys). */
  readonly onSelect: (id: SectionId) => void;
  /** Per-section validity bag — invalid saved sections show a nav badge. */
  readonly sectionValidity: SectionValidity;
  /** Shared `useId()` base so each tab's `aria-controls` resolves to the panel
   *  the parent renders with the matching `${idBase}-panel-${id}` id. */
  readonly idBase: string;
}

/** The sections that own a save button (and so carry a validity flag). */
const SAVED_SECTIONS: readonly SectionId[] = [
  'profile',
  'categories',
  'routing',
  'daily-reset',
  'state-machine',
];

/** Maps a kebab `SectionId` to its camelCase key on `SectionValidity`. The
 *  union carries kebab ids (used as tab keys + DOM id suffixes); the validity
 *  bag uses camelCase (TS-idiomatic). This is the single place that bridge
 *  lives, so a new saved section only adds one entry here. */
const VALIDITY_KEY: Record<Exclude<SectionId, 'manual'>, keyof SectionValidity> = {
  profile: 'profile',
  categories: 'categories',
  routing: 'routing',
  'daily-reset': 'dailyReset',
  'state-machine': 'stateMachine',
};

export function ConfigSectionNav({
  active,
  onSelect,
  sectionValidity,
  idBase,
}: ConfigSectionNavProps) {
  const tabId = (id: SectionId) => `${idBase}-tab-${id}`;
  const panelId = (id: SectionId) => `${idBase}-panel-${id}`;

  /** `true` when a saved section's inputs are invalid (drives the nav badge). */
  function isInvalid(id: SectionId): boolean {
    return (
      SAVED_SECTIONS.includes(id) &&
      sectionValidity[VALIDITY_KEY[id as Exclude<SectionId, 'manual'>]] === false
    );
  }

  /** Move focus AND activate by delta, wrapping at the ends (auto-activation is
   *  safe — the draft is centralized, so a switch never loses edits). */
  function move(delta: number) {
    const idx = CONFIG_SECTIONS.findIndex((s) => s.id === active);
    const next = (idx + delta + CONFIG_SECTIONS.length) % CONFIG_SECTIONS.length;
    const nextId = CONFIG_SECTIONS[next].id;
    onSelect(nextId);
    // Focus the newly-active tab. The button already exists in the DOM (roving
    // tabindex only toggles `tabindex`/`aria-selected`, never mounts/unmounts),
    // so focus lands immediately, before React flushes the re-render.
    document.getElementById(tabId(nextId))?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, id: SectionId) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        onSelect(CONFIG_SECTIONS[0].id);
        document.getElementById(tabId(CONFIG_SECTIONS[0].id))?.focus();
        break;
      case 'End':
        e.preventDefault();
        onSelect(CONFIG_SECTIONS[CONFIG_SECTIONS.length - 1].id);
        document.getElementById(tabId(CONFIG_SECTIONS[CONFIG_SECTIONS.length - 1].id))?.focus();
        break;
      case 'Enter':
      case ' ':
        // Click already selects; this covers keyboard activation when focus
        // arrives via roving (the focused tab is already active, so this is a
        // no-op reaffirm, but keeps the contract explicit for AT users).
        e.preventDefault();
        onSelect(id);
        break;
    }
  }

  return (
    <div
      className="admin-config__nav"
      role="tablist"
      aria-label="Bagian konfigurasi"
      aria-orientation="vertical"
    >
      {CONFIG_SECTIONS.map((section) => {
        const isActive = section.id === active;
        const invalid = isInvalid(section.id);
        return (
          <button
            key={section.id}
            id={tabId(section.id)}
            type="button"
            role="tab"
            className={`admin-config__nav-item${isActive ? ' admin-config__nav-item--active' : ''}`}
            aria-selected={isActive}
            aria-controls={panelId(section.id)}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(section.id)}
            onKeyDown={(e) => onKeyDown(e, section.id)}
          >
            <span className="admin-config__nav-label">{section.label}</span>
            {invalid && (
              <span className="admin-config__nav-badge" aria-hidden="true" />
            )}
            {invalid && <span className="sr-only">belum valid</span>}
          </button>
        );
      })}
    </div>
  );
}