/**
 * Decorative inline-SVG icons for the grouped left navigation (QUE-45). Each
 * icon is a small hand-rolled stroke path — NO icon library (NFR-REL-01,
 * consistent with the hand-rolled chart SVGs in `DashboardCharts` /
 * `RecapCharts` / `RoutingGraph`).
 *
 * Accessibility: these are **decorative** — the adjacent nav label is the
 * accessible name, so every `<svg>` carries `aria-hidden="true"` +
 * `focusable="false"` and has NO `role` / `aria-label` / `<title>` (a
 * meaningful-image convention would add a redundant duplicate announcement).
 * This is deliberately different from the chart SVGs, which are meaningful
 * (`role="img"` + `aria-label`).
 */
function navIcon(children: React.ReactNode) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function DashboardIcon() {
  // A four-quadrant grid — "operational overview" dashboard.
  return navIcon(
    <>
      <rect x={3} y={3} width={7.5} height={7.5} rx={1.5} />
      <rect x={13.5} y={3} width={7.5} height={7.5} rx={1.5} />
      <rect x={3} y={13.5} width={7.5} height={7.5} rx={1.5} />
      <rect x={13.5} y={13.5} width={7.5} height={7.5} rx={1.5} />
    </>,
  );
}

export function AnalyticsIcon() {
  // Three bars of increasing height — "historical analytics".
  return navIcon(
    <>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </>,
  );
}

export function ConfigIcon() {
  // A gear — "system configuration".
  return navIcon(
    <>
      <circle cx={12} cy={12} r={3.2} />
      <path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1 5.3 5.3" />
    </>,
  );
}

export function AuditIcon() {
  // A document with lines — "audit log / record".
  return navIcon(
    <>
      <path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h6M9 9h2" />
    </>,
  );
}

export function UsersIcon() {
  // Two figures — "users / accounts" (placeholder until AuthN/AuthZ lands).
  return navIcon(
    <>
      <circle cx={9} cy={8} r={3} />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-3-4.9" />
    </>,
  );
}

export function TvLayoutIcon() {
  // A display screen with stacked panels of varying height — "TV panel layout".
  return navIcon(
    <>
      <rect x={3} y={4} width={18} height={13} rx={1.5} />
      <path d="M6 14V8M10 14v-3M14 14v-2M18 14V9" />
      <path d="M9 20h6" />
    </>,
  );
}

export function SpeakerIcon() {
  // A speaker with sound waves — "announcement voice".
  return navIcon(
    <>
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </>,
  );
}

export function PrinterIcon() {
  // A printer with a paper feed — "printer configuration".
  return navIcon(
    <>
      <path d="M6 9V3h12v6" />
      <path d="M6 18H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2" />
      <rect x={6} y={14} width={12} height={7} rx={1} />
      <path d="M8 7h.01" />
    </>,
  );
}

export function ProfileIcon() {
  // A storefront with a peaked roof + a window — "store profile & appearance".
  return navIcon(
    <>
      <path d="M4 9.5 5.5 5h13L20 9.5" />
      <path d="M4 9.5h16V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z" />
      <path d="M4 9.5a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0" />
      <path d="M10 21v-5h4v5" />
    </>,
  );
}

export function CategoryIcon() {
  // A stack of two layered tags/tickets — "categories".
  return navIcon(
    <>
      <path d="M3.5 8.5 9.5 3.5h6v6L10.5 14.5a1.4 1.4 0 0 1-2 0L3.5 9.5a1.4 1.4 0 0 1 0-1Z" />
      <path d="M8 9.5h.01" />
      <path d="M7 17.5 13 12.5h6v6L13.5 23.5a1.4 1.4 0 0 1-2 0L7 18.5a1.4 1.4 0 0 1 0-1Z" />
    </>,
  );
}

export function CounterRoutingIcon() {
  // A counter window + branching arrows — "counter & routing".
  return navIcon(
    <>
      <rect x={3} y={5} width={8} height={14} rx={1} />
      <path d="M6 9h2M6 13h2M6 17h2" />
      <path d="M14 8h3a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3h-3" />
      <path d="M16 12l-2-2 2-2" />
      <path d="M14 18h3a3 3 0 0 0 3-3v0" />
    </>,
  );
}

export function ResetDailyIcon() {
  // A circular arrow + a sun — "daily reset / roll-over".
  return navIcon(
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v3h-3" />
      <circle cx={12} cy={12} r={2.5} />
    </>,
  );
}

export function ManualOpsIcon() {
  // A wrench + gear — "manual operations / overrides".
  return navIcon(
    <>
      <path d="M14.5 5.5a3.5 3.5 0 0 1 4 4l-9 9-3.5.5.5-3.5Z" />
      <path d="M13 7 17 11" />
      <circle cx={18} cy={18} r={2.2} />
      <path d="M18 14.5v1.3M18 20.2v1.3M21.5 18h-1.3M15.8 18h-1.3" />
    </>,
  );
}