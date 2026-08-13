import type { ReactNode } from 'react';
import {
  AnalyticsIcon,
  AuditIcon,
  CategoryIcon,
  ConfigIcon,
  CounterRoutingIcon,
  DashboardIcon,
  ManualOpsIcon,
  PrinterIcon,
  ProfileIcon,
  ResetDailyIcon,
  TvLayoutIcon,
  UsersIcon,
} from './nav-icons';

/**
 * The grouped, task-oriented left-navigation information architecture (QUE-45),
 * now a TWO-LEVEL sidebar (big group → small group → leaf) so the growing
 * `Konfigurasi Sistem` area stays scannable.
 *
 * The nav is data-driven so the structure is testable and `AppShell` stays
 * focused on rendering. A group has EITHER flat `items` (a single-level group:
 * Operasional, Analitik, Audit, Pengguna) OR nested `subgroups` (a two-level
 * group: only `Konfigurasi Sistem` so far, split into Tampilan / Antrean /
 * Sistem). Always expanded — no accordion (the manager never has to hunt for a
 * collapsed group). Group + subgroup labels are friendly Bahasa Indonesia
 * strings — no internal/technical terms (no `FIFO_GLOBAL` / raw enum / cron
 * text) per the QUE-34 / QUE-45 rule. The labels are inline literals (there is
 * no backend enum to keep in sync, so a `Record<NavKey,string>` map would be
 * over-engineering — the "tiny leaf, don't over-abstract" rule).
 *
 * The two existing config navs were consolidated into this ONE nav: the
 * in-content `ConfigSectionNav` tablist is gone, and each config section is a
 * real route under `/config/*` (generalizing the existing `/config/alur-status`
 * pattern). `ConfigDraftProvider` stays mounted across all `/config/*` children,
 * so the shared mutable draft + one full-payload `PUT /api/system/config` save
 * persist across section navigation (the load-bearing contract). TV
 * (`/tv-layout`) and Printer (`/printer-config`) stay on their existing routes
 * — they are just placed into the right small group (Tampilan / Sistem).
 *
 * `Pengguna` resolves to the real `/users` surface landed by QUE-43
 * (AuthN/AuthZ + user management). It was originally a disabled placeholder
 * ("segera hadir") while AuthN/AuthZ was pending; QUE-43 merged first, so on
 * rebase the placeholder became a real enabled link (deferring to the merged
 * canonical surface — no dead disabled machinery remains).
 */
export interface NavLeaf {
  /** Friendly Bahasa Indonesia label (never a raw enum / internal term). */
  readonly label: string;
  /** Route path the item navigates to (`/` for Dashboard). */
  readonly to: string;
  /** Decorative inline-SVG icon (aria-hidden — the label is the a11y name). */
  readonly icon: ReactNode;
  /** `NavLink` `end` prop — true for the `/` (Dashboard) route only. */
  readonly end?: boolean;
}

/** A second-level cluster inside a two-level group (e.g. Antrean, Sistem). */
export interface NavSubGroup {
  /** Sub-group heading (Tampilan, Antrean, Sistem) — friendly Indonesian. */
  readonly label: string;
  readonly items: readonly NavLeaf[];
}

/**
 * A nav group is EITHER flat (`items`) OR two-level (`subgroups`) — a
 * discriminated union so the two shapes are mutually exclusive at the type
 * level (a group cannot have both, and `AppShell`'s `group.subgroups ?` check
 * narrows to the right variant). The explicit `undefined` counterpart on each
 * member keeps the truthy-check narrowing sound while letting the render read
 * `group.items` / `group.subgroups` without a type error on the other variant.
 */
export type NavGroup =
  | {
      /** Big-group heading (Operasional, Analitik, …) — friendly Indonesian. */
      readonly label: string;
      /** Flat single-level items — the group has NO subgroups. */
      readonly items: readonly NavLeaf[];
      readonly subgroups?: undefined;
    }
  | {
      /** Big-group heading (Konfigurasi Sistem) — friendly Indonesian. */
      readonly label: string;
      /** Nested second-level clusters — the group is two-level. */
      readonly subgroups: readonly NavSubGroup[];
      readonly items?: undefined;
    };

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
    // The only two-level group: the config area grew past a flat list, so it is
    // split into Tampilan / Antrean / Sistem sub-groups. The leaves map 1:1 to
    // the `/config/*` child routes (the in-content tablist was consolidated into
    // this sidebar). TV + Printer keep their existing non-`/config` routes —
    // they are placed in the right sub-group, not moved.
    subgroups: [
      {
        label: 'Tampilan',
        items: [
          { label: 'Profil & Tampilan', to: '/config/profil', icon: <ProfileIcon /> },
          { label: 'Tampilan TV', to: '/tv-layout', icon: <TvLayoutIcon /> },
        ],
      },
      {
        label: 'Antrean',
        items: [
          { label: 'Kategori', to: '/config/kategori', icon: <CategoryIcon /> },
          { label: 'Counter & Routing', to: '/config/counter-routing', icon: <CounterRoutingIcon /> },
          { label: 'Alur Status Tiket', to: '/config/alur-status', icon: <ConfigIcon /> },
        ],
      },
      {
        label: 'Sistem',
        items: [
          { label: 'Reset Harian', to: '/config/reset-harian', icon: <ResetDailyIcon /> },
          { label: 'Operasi Manual', to: '/config/operasi-manual', icon: <ManualOpsIcon /> },
          { label: 'Konfigurasi Printer', to: '/printer-config', icon: <PrinterIcon /> },
        ],
      },
    ],
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