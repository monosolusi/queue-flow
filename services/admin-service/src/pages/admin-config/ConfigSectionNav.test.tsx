import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ConfigSectionNav, type SectionValidity } from './ConfigSectionNav';
import { CONFIG_SECTIONS, type SectionId } from './config-sections';

const ALL_VALID: SectionValidity = {
  profile: true,
  categories: true,
  routing: true,
  dailyReset: true,
  stateMachine: true,
};

/**
 * A stateful wrapper so the keyboard/focus tests exercise the real
 * activation path — `onSelect` updates `active`, which re-renders the nav
 * with the new roving `tabindex`/`aria-selected`. A plain `vi.fn()` mock would
 * leave `active` unchanged and the assertions on `aria-selected`/focus would
 * be vacuous.
 */
function StatefulNav({
  initialActive = 'profile' as SectionId,
  validity = ALL_VALID,
  idBase = 'cfg',
}: {
  initialActive?: SectionId;
  validity?: SectionValidity;
  idBase?: string;
} = {}) {
  const [active, setActive] = useState<SectionId>(initialActive);
  return (
    <>
      {/* A panel stub carrying the id the tab's aria-controls resolves to, so
          the contract is checked end-to-end (the real panel renders in
          AdminPanel; here it is just an id carrier). */}
      <div id={`${idBase}-panel-${active}`} role="tabpanel" data-testid="panel-stub" />
      <ConfigSectionNav active={active} onSelect={setActive} sectionValidity={validity} idBase={idBase} />
    </>
  );
}

/** Exact-name match is fragile once a tab appends the "belum valid" sr-only
 *  label to its accessible name; match the section label as a regex instead. */
function tab(label: string): HTMLElement {
  return screen.getByRole('tab', { name: new RegExp(label) });
}

describe('ConfigSectionNav (ARIA tablist)', () => {
  it('renders a tablist labelled "Bagian konfigurasi" with one tab per section', () => {
    render(<StatefulNav />);
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-label', 'Bagian konfigurasi');
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(CONFIG_SECTIONS.length);
    expect(
      tabs.map((t) => t.textContent?.replace('belum valid', '').trim()),
    ).toEqual(CONFIG_SECTIONS.map((s) => s.label));
  });

  it('roves tabindex + aria-selected: the active tab is 0/true, the rest -1/false', () => {
    render(<StatefulNav initialActive="routing" />);
    CONFIG_SECTIONS.forEach((section) => {
      const t = tab(section.label);
      const isActive = section.id === 'routing';
      expect(t).toHaveAttribute('aria-selected', String(isActive));
      expect(t).toHaveAttribute('tabindex', isActive ? '0' : '-1');
    });
  });

  it('pairs each tab aria-controls with the matching ${idBase}-panel-${id} id', () => {
    render(<StatefulNav initialActive="profile" />);
    CONFIG_SECTIONS.forEach((section) => {
      const t = tab(section.label);
      expect(t).toHaveAttribute('aria-controls', `cfg-panel-${section.id}`);
      expect(t).toHaveAttribute('id', `cfg-tab-${section.id}`);
    });
  });

  it('clicking a tab selects it', () => {
    render(<StatefulNav initialActive="profile" />);
    fireEvent.click(tab('Kategori'));
    expect(tab('Kategori')).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowDown moves focus + activates, wrapping at the end', () => {
    render(<StatefulNav initialActive="profile" />);
    const profile = tab('Profil & Tampilan');
    profile.focus();
    fireEvent.keyDown(profile, { key: 'ArrowDown' });
    // Activation moved to categories, and focus followed it (roving tab).
    const kategori = tab('Kategori');
    expect(kategori).toHaveAttribute('aria-selected', 'true');
    expect(kategori).toHaveFocus();
    expect(profile).toHaveAttribute('tabindex', '-1');

    // Wrap: from the last section (manual) ArrowDown returns to profile.
    fireEvent.keyDown(kategori, { key: 'ArrowDown' });
    fireEvent.keyDown(tab('Counter & Routing'), { key: 'ArrowDown' });
    fireEvent.keyDown(tab('Reset Harian'), { key: 'ArrowDown' });
    fireEvent.keyDown(tab('Alur Status Tiket'), { key: 'ArrowDown' });
    fireEvent.keyDown(tab('Operasi Manual'), { key: 'ArrowDown' });
    expect(tab('Profil & Tampilan')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Profil & Tampilan')).toHaveFocus();
  });

  it('ArrowUp moves focus + activates, wrapping at the start', () => {
    render(<StatefulNav initialActive="profile" />);
    const profile = tab('Profil & Tampilan');
    profile.focus();
    fireEvent.keyDown(profile, { key: 'ArrowUp' });
    // Wrap from the first tab to the last (manual).
    const manual = tab('Operasi Manual');
    expect(manual).toHaveAttribute('aria-selected', 'true');
    expect(manual).toHaveFocus();
  });

  it('Home jumps to the first tab, End to the last, both activating', () => {
    render(<StatefulNav initialActive="routing" />);
    const routing = tab('Counter & Routing');
    routing.focus();
    fireEvent.keyDown(routing, { key: 'Home' });
    const profile = tab('Profil & Tampilan');
    expect(profile).toHaveAttribute('aria-selected', 'true');
    expect(profile).toHaveFocus();

    fireEvent.keyDown(profile, { key: 'End' });
    const manual = tab('Operasi Manual');
    expect(manual).toHaveAttribute('aria-selected', 'true');
    expect(manual).toHaveFocus();
  });

  it('renders an error badge (aria-hidden dot + sr-only "belum valid") only on invalid saved sections', () => {
    render(<StatefulNav initialActive="profile" validity={{ ...ALL_VALID, routing: false }} />);
    const routingTab = tab('Counter & Routing');
    expect(routingTab.querySelector('.admin-config__nav-badge')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(routingTab).toHaveTextContent('belum valid');

    // A valid saved section has no badge.
    const profileTab = tab('Profil & Tampilan');
    expect(profileTab.querySelector('.admin-config__nav-badge')).toBeNull();
    expect(profileTab).not.toHaveTextContent('belum valid');

    // The manual section is never badged (no save → no validity flag).
    const manualTab = tab('Operasi Manual');
    expect(manualTab.querySelector('.admin-config__nav-badge')).toBeNull();
  });

  it('drops the badge once the section becomes valid again', () => {
    const { rerender } = render(
      <StatefulNav initialActive="routing" validity={{ ...ALL_VALID, routing: false }} />,
    );
    expect(tab('Counter & Routing')).toHaveTextContent('belum valid');
    rerender(<StatefulNav initialActive="routing" validity={ALL_VALID} />);
    expect(tab('Counter & Routing')).not.toHaveTextContent('belum valid');
  });
});