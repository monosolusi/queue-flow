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