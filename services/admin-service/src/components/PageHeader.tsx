/**
 * Shared in-shell page header (layout-consistency refactor).
 *
 * The admin-service shell wraps every routed page in a single
 * `<main id="main-content">` landmark and renders the topbar title as a
 * non-heading `<span>` (AC8 — the routed page owns the `<h1>`). Each in-shell
 * page previously hand-rolled its own `<header class="<page>__header">` with a
 * duplicated `<h1 class="<page>__title">` + `<p class="<page>__subtitle">` +
 * optional `<div class="<page>__controls">`. The 4× duplicated markup + CSS
 * diverged on root container geometry too (`.status-dashboard` was wider with
 * extra horizontal padding). This component collapses the header markup + CSS
 * into one shared, presentational block (SRP — no state, no context).
 *
 * **AC8 invariant:** this component renders the `<h1>` — the page owns the
 * heading. Never promote the shell topbar span to a heading. Keep `<h1>` as
 * the first heading in the page body.
 *
 * The optional `actions` slot replaces the per-page `__controls` div. When the
 * actions need bottom alignment (e.g. the analytics date pickers carry labels
 * above their inputs and must align with the heading's baseline), pass
 * `actionsAlign="end"`; the default is `center` (used by the dashboard's
 * Muat Ulang button + last-updated stamp).
 */
import type { ReactNode } from 'react';

export interface PageHeaderProps {
  /** The page heading — rendered as the single `<h1>` for the page (AC8). */
  title: string;
  /** Optional subheading rendered as a muted `<p>` under the title. */
  subtitle?: string;
  /** Optional right-aligned action controls (buttons, date pickers, links). */
  actions?: ReactNode;
  /** Actions row alignment — `center` (default) or `end` (bottom-aligned, for
   *  controls with labels above their inputs, e.g. the analytics date pickers). */
  actionsAlign?: 'center' | 'end';
}

export function PageHeader({ title, subtitle, actions, actionsAlign = 'center' }: PageHeaderProps) {
  const actionsClass =
    actionsAlign === 'end' ? 'page-header__actions page-header__actions--align-end' : 'page-header__actions';
  return (
    <header className="page-header">
      <div className="page-header__heading">
        <h1 className="page-header__title">{title}</h1>
        {subtitle !== undefined && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className={actionsClass}>{actions}</div>}
    </header>
  );
}