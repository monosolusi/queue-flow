import type { ReactNode } from 'react';
import { AnalyticsIcon, AuditIcon, ConfigIcon, DashboardIcon, UsersIcon } from './nav-icons';

/**
 * The grouped, task-oriented left-navigation information architecture (QUE-45).
 *
 * The nav is data-driven so the structure is testable and `AppShell` stays
 * focused on rendering. Groups are the manager's daily workflow categories
 * (Operasional / Analitik / Konfigurasi Sistem / Audit / Pengguna); each group
 * label is a friendly Bahasa Indonesia string — no internal/technical terms
 * (no `FIFO_GLOBAL` / raw enum / cron text) per the QUE-34 / QUE-45 rule. The
 * labels are inline literals (there is no backend enum to keep in sync, so a
 * `Record<NavKey,string>` map would be over-engineering — the "tiny leaf,
 * don't over-abstract" rule).
 *
 * `Pengguna` resolves to the real `/users` surface landed by QUE-43
 * (AuthN/AuthZ + user management). It was originally a disabled placeholder
 * ("segera hadir") while AuthN/AuthZ was pending; QUE-43 merged first, so on
 * rebase the placeholder became a real enabled link (deferring to the merged
 * canonical surface — no dead disabled machinery remains).
 */
export interface NavItem {
  /** Friendly Bahasa Indonesia label (never a raw enum / internal term). */
  readonly label: string;
  /** Route path the item navigates to (`/` for Dashboard). */
  readonly to: string;
  /** Decorative inline-SVG icon (aria-hidden — the label is the a11y name). */
  readonly icon: ReactNode;
  /** `NavLink` `end` prop — true for the `/` (Dashboard) route only. */
  readonly end?: boolean;
}

export interface NavGroup {
  /** Group heading (Operasional, Analitik, …) — friendly Indonesian. */
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Operasional',
    // QUE-44 renamed the `/` landing concept from "Dashboard" to "Status
    // Antrian" (it is now live operational status, not KPI tiles). The nav
    // label follows QUE-44's canonical name; the topbar title + page <h1>
    // match (pageTitleFor returns "Status Antrian").
    items: [{ label: 'Status Antrian', to: '/', icon: <DashboardIcon />, end: true }],
  },
  {
    label: 'Analitik',
    // QUE-44 renamed the `/analytics` view to "Analitik & Laporan" (it is now
    // multi-day range analytics + export, not a single-day "Analitik Harian").
    items: [{ label: 'Analitik & Laporan', to: '/analytics', icon: <AnalyticsIcon /> }],
  },
  {
    label: 'Konfigurasi Sistem',
    items: [{ label: 'Konfigurasi', to: '/config', icon: <ConfigIcon /> }],
  },
  {
    label: 'Audit',
    items: [{ label: 'Log Audit', to: '/audit', icon: <AuditIcon /> }],
  },
  {
    label: 'Pengguna',
    items: [{ label: 'Pengguna', to: '/users', icon: <UsersIcon /> }],
  },
];