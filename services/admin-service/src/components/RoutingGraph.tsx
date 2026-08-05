/**
 * Read-only auto-generated bipartite SVG of the counter↔category routing on
 * the wizard's Step 5 review (FR-WZD-06). Replaces the flat bulleted list of
 * raw category codes ("Counter 1 (…) → A, B") with a visual: counter nodes on
 * the left, category nodes on the right, an edge for each assigned category.
 *
 * Hand-rolled offline SVG (NFR-REL-01 — no chart/graph library, no CDN),
 * mirroring the `RecapCharts` precedent. Labels are category **names** and
 * counter names — never raw codes — per the friendly-copy rule. Pure
 * presentational: fed by `routingRules` + `categories`; no state, no API.
 */
interface RoutingRuleLike {
  readonly counterName: string;
  readonly assignedCategoryCodes: readonly string[];
}
interface CategoryLike {
  readonly code: string;
  readonly name: string;
}

interface RoutingGraphProps {
  routingRules: readonly RoutingRuleLike[];
  categories: readonly CategoryLike[];
}

// SVG geometry (viewBox user units). The svg scales to its container via
// `width:100%`; nodes are fixed-width rounded rects, edges straight lines.
const VIEW_W = 480;
const PAD_TOP = 20;
const PAD_BOTTOM = 20;
const NODE_W = 150;
const NODE_H = 28;
const ROW_GAP = 10;
const LEFT_X = 8; // left edge of counter nodes
const RIGHT_X = VIEW_W - NODE_W - 8; // left edge of category nodes

function nodeCenterY(i: number, count: number, viewH: number): number {
  // Evenly distribute `count` nodes within [PAD_TOP, viewH - PAD_BOTTOM].
  if (count <= 1) return viewH / 2;
  const usable = viewH - PAD_TOP - PAD_BOTTOM - NODE_H;
  const step = usable / (count - 1);
  return PAD_TOP + i * step + NODE_H / 2;
}

export function RoutingGraph({ routingRules, categories }: RoutingGraphProps) {
  const codeToName = new Map(categories.map((c) => [c.code, c.name]));

  // Only draw category nodes that are actually wired to ≥1 counter — avoids
  // orphan right-column nodes and keeps the graph readable.
  const referencedCodes = new Set<string>();
  for (const rule of routingRules) {
    for (const code of rule.assignedCategoryCodes) referencedCodes.add(code);
  }
  const referencedCategories = categories.filter((c) => referencedCodes.has(c.code));
  const unreferencedCategories = categories.filter((c) => !referencedCodes.has(c.code));

  const nCounters = routingRules.length;
  const nCategories = referencedCategories.length;
  const viewH = Math.max(
    160,
    PAD_TOP + Math.max(nCounters, nCategories) * (NODE_H + ROW_GAP) - ROW_GAP + PAD_BOTTOM,
  );

  const summary = `Grafik routing: ${nCounters} counter, ${nCategories} kategori`;

  // Build edges: for each counter, a <line> to each assigned category node.
  const edges: { x1: number; y1: number; x2: number; y2: number; title: string }[] = [];
  routingRules.forEach((rule, ci) => {
    const cy = nodeCenterY(ci, nCounters, viewH);
    rule.assignedCategoryCodes.forEach((code) => {
      const ri = referencedCategories.findIndex((c) => c.code === code);
      if (ri < 0) return; // stale code (category removed) — skip the edge
      edges.push({
        x1: LEFT_X + NODE_W,
        y1: cy,
        x2: RIGHT_X,
        y2: nodeCenterY(ri, nCategories, viewH),
        title: `${rule.counterName || 'Counter'} → ${codeToName.get(code) ?? code}`,
      });
    });
  });

  return (
    <div className="routing-graph" data-testid="review-routing">
      <svg
        className="routing-graph__svg"
        viewBox={`0 0 ${VIEW_W} ${viewH}`}
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Edges first so nodes sit on top. */}
        {edges.map((e, i) => (
          <line
            key={i}
            className="routing-graph__edge"
            x1={e.x1}
            y1={e.y1}
            x2={e.x2}
            y2={e.y2}
          >
            <title>{e.title}</title>
          </line>
        ))}
        {/* Counter nodes (left). */}
        {routingRules.map((rule, i) => {
          const cy = nodeCenterY(i, nCounters, viewH);
          return (
            <g key={`c-${i}`}>
              <rect
                className="routing-graph__node routing-graph__node--counter"
                x={LEFT_X}
                y={cy - NODE_H / 2}
                width={NODE_W}
                height={NODE_H}
                rx={6}
              />
              <text
                className="routing-graph__node-label"
                x={LEFT_X + NODE_W / 2}
                y={cy + 4}
                textAnchor="middle"
              >
                {rule.counterName || `Counter ${i + 1}`}
              </text>
            </g>
          );
        })}
        {/* Category nodes (right). */}
        {referencedCategories.map((c, i) => {
          const cy = nodeCenterY(i, nCategories, viewH);
          return (
            <g key={`k-${c.code}`}>
              <rect
                className="routing-graph__node routing-graph__node--category"
                x={RIGHT_X}
                y={cy - NODE_H / 2}
                width={NODE_W}
                height={NODE_H}
                rx={6}
              />
              <text
                className="routing-graph__node-label"
                x={RIGHT_X + NODE_W / 2}
                y={cy + 4}
                textAnchor="middle"
              >
                {c.name}
              </text>
            </g>
          );
        })}
      </svg>
      {unreferencedCategories.length > 0 && (
        <p className="routing-graph__legend">
          Kategori tanpa counter: {unreferencedCategories.map((c) => c.name).join(', ')}
        </p>
      )}
    </div>
  );
}