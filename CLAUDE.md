# CLAUDE.md — Enterprise Offline Queue Management System (QMS)

> Source of truth: the Linear PRD under the **Queue System** team (key `QUE`),
> project "Enterprise Offline Queue Management System (QMS)". PRD wins over
> this file when they disagree — update this file to match.

Offline, on-premise queue management for a single branch/store. Runs 100% on a
local LAN — **no internet, no cloud, no external CDN/API calls at runtime**.
Visitors take tickets at a kiosk, staff call them from a counter panel, a TV
board shows now-serving with sequential audio. A manager administers
categories, counters, the state machine, and daily-reset policy via an admin
panel + first-run setup wizard. PRD is in **Bahasa Indonesia**; UI
`action_label` values ("Panggil Berikutnya", "Lewati / Absen", "Selesai Layan")
are Indonesian — match verbatim.

## Commands

Per-service scripts run from that service's directory.

| Task | Command |
|---|---|
| Bring up the whole stack | `docker compose up -d` (root) |
| Per-service unit + build gate | `npm run verify` (root, `scripts/run-verify.mjs`) |
| core-api arch check | `npm run arch:check` (in `services/core-api`) — dep-cruiser, **must stay clean** |
| core-api unit / build | `npm test` / `npm run build` (in `services/core-api`) — `postbuild` copies `.sql` |
| core-api acceptance | `npm run test:acceptance` (in `services/core-api`) |
| Acceptance runner (builds first) | `npm run acceptance` (root) |
| Topology smoke test (Docker) | `npm run compose:verify` (root) |
| Frontend dev/build/test | `npm run dev` / `npm run build` / `npm test` (in `services/<svc>`) — vitest |
| Compose up/down | `npm run compose:up` / `npm run compose:down` (root) |

`QMS_PERSISTENCE=postgres` activates Postgres bindings (default `in-memory`).
Acceptance specs needing a real DB gate on `QMS_ACCEPTANCE_DB_URL` (some also on
`dist/main.js`).

## Architecture

Single-host: every service is a Docker container on **one** local PC server,
fronted by an NGINX reverse proxy (`gateway`, ports 80/443).

| Service | Stack | Int. | External | Responsibility |
|---|---|---|---|---|
| `gateway` | NGINX Alpine | 80,443 | `http://antrian.local/` | Reverse proxy, static assets, SSL, first-run routing |
| `core-api-service` | NestJS/Express | 3000 | `/api/*`, `/ws` | Business logic, state machine, routing, WS, DB |
| `kiosk-service` | React PWA | 3001 | `/kiosk` | Visitor touchscreen ticket UI + thermal printing |
| `tv-display-service` | React | 3002 | `/tv` | TV queue board + offline audio synthesizer |
| `caller-service` | React PWA | 3003 | `/caller` | Counter staff panel, dynamic action buttons |
| `admin-service` | React | 3004 | `/admin`, `/wizard` | Manager control panel, wizard, analytics, master data |
| `db-service` | PostgreSQL 15 / SQLite | 5432 | internal | Queue transactions, system config, audit trail |

**Clean Architecture (core-api):** Infrastructure (Express, Postgres, WS) →
Interface Adapters (Controllers, Presenters, Repos) → Application (use cases) →
Domain (entities, VOs, aggregates, events, ports). **NFR-MNT-01:** Domain has
**zero** deps on ORM/HTTP/IO (incl. Node built-ins `crypto|fs|net|http|https|
tls|child_process`). High-level modules depend on abstractions, never concrete
infrastructure (DIP).

**SOLID:** SRP — each UI service owns one concern (tv renders+audio only; kiosk
owns printing only). OCP — `AudioProvider` (tv) is an interface; add providers
without touching the TV store; `QueuedAudioProvider` decorates any
`AudioProvider` to serialize whole announcements FIFO (FR-TV-02). LSP —
`IQueueRepository` impls (Postgres + in-memory) must be interchangeable. ISP —
`caller-service` consumes only `ICallerApi`; never leak admin/reporting DTOs.
DIP — use cases & domain depend on interfaces, not the ORM/DB directly.

## Domain model (DDD bounded contexts)

Four bounded contexts: **Queue**, **Store Config**, **Reporting**, **Identity**.
(Notification is a pure `tv-display-service` client concern — no core-api domain
model; the backend never plays sound, so no `domain/notification` context — a
server-side audio model would be over-abstraction.)

- **Queue** — `QueueTicket` aggregate (`TicketId` UUID, `ticketNumber` e.g.
  "A-001", `categoryId`, `currentStatus`, `counterId`, timestamps). Events:
  `TicketCreatedEvent`, `TicketStatusChangedEvent`, `DailyQueueResetEvent`.
- **Store Config** — `SystemConfiguration` aggregate
  (`isInitialSetupCompleted`, `storeName`; VOs `StateSchema`,
  `StateTransitionRule`, `DailyResetPolicy`) + `CounterRoutingRule` aggregate
  (`counterId`, `assignedCategoryIds`, `priorityPolicy` ∈ {`FIFO_GLOBAL`,
  `CATEGORY_PRIORITY`}).
- **Reporting** — `DailyQueueReport`, `CounterPerformance`.
- **Identity (QUE-43)** — `User` entity (`Identifier` UUID, `Username`,
  `PasswordHash`, `Role` ∈ {`admin`, `caller-staff`}, timestamps) + RBAC.

Default state machine: `WAITING → CALLING → SERVING → COMPLETED`, plus
`SKIPPED` (from `CALLING`, returns via "Panggil Ulang"). Custom states
(`PREPARING`, `PAYMENT`, …) are wizard-configurable; each transition carries an
`action_label` → Caller UI button.

**Transfer Queue** ("pindah kategori", FR-CLR-03) is a first-class configurable
transition, not a special case: `TransferTicketUseCase` validates
`currentStatus → targetStatus` (default `WAITING`) against the active
`ITransitionPolicy`, then reassigns category + reissues a per-category number
(clearing the counter). PRD §7 default machine has no transfer edge →
`InvalidStateTransitionException` until the wizard adds one. Pre-checks before
reserving the new number so an illegal transfer burns no sequence (NFR-REL-02).

The full reference config JSON (store name, daily_reset, state_machine,
categories, routings) lives in PRD §7 — read it before touching config code.

## Hard constraints (do not violate)

- **No internet at runtime (NFR-REL-01).** All assets served from the local PC
  server. Never add an external CDN link / `<script src="https://…">` / remote
  API call to runtime code. Bundling must inline/vendor everything.
- **Power-loss resilient (NFR-REL-02).** PostgreSQL/SQLite + WAL. After a power
  cut, ticket numbers + transaction state recover exactly — no dupes, no gaps.
  Design writes so a crash mid-operation leaves the DB consistent.
- **Container self-healing (NFR-REL-03).** Every `docker-compose.yml` service
  uses `restart: always`.
- **Latency budgets.** Internal HTTP p99 < 100 ms (NFR-PERF-01). WS caller→TV <
  150 ms on LAN (NFR-PERF-02). Kiosk physical print < 1.5 s (NFR-PERF-03).
- **Local network only (NFR-SEC-01).** App access restricted to the store LAN
  subnet.
- **Audit trail (NFR-SEC-02).** Manual reset, state-schema changes, routing
  changes must write to the audit log. The audit `actor` is the
  **authenticated principal's username** (QUE-43) — never client-supplied or a
  hardcoded literal; the first-run wizard path (no principal yet) uses a
  `'system'` sentinel.
- **Clean architecture layering (NFR-MNT-01).** Domain has no framework/ORM/IO
  imports — enforced by static analysis (acceptance criterion).
- **Single-host readiness (NFR-MNT-02).** Whole stack comes up with one command,
  `docker compose up -d`. Any new service must be in `docker-compose.yml` (with
  `restart: always`) and routed by the `gateway`; no separate bring-up step.

## Project status

Milestones (Linear): (1) Foundation & Architecture; (2) Core Queue Workflow; (3)
Operational Interfaces; (4) Hardening & Acceptance. DoD (PRD §8): static
analysis proves Domain dependency-free; first-run wizard redirects a clean
browser to `/wizard` and completes 4 steps; full flow (kiosk ticket → thermal
print → caller → TV audio/display) works with WAN cable unplugged; power-cut
recovery passes with no duplicate/lost ticket numbers.

- **Git:** remote `monosolusi/queue-flow`, default `main`. Branch naming:
  `<type>/que-<n>-<slug>` (`feat`/`fix`/`refactor`/`chore`) — overrides Linear's
  `franssiswanto/que-…`.
- **core-api:** NestJS + TypeScript. Clean Architecture layers in place; Domain
  pure (dep-cruiser-enforced). All queue command use cases, ticket generation,
  daily reset, PostgreSQL persistence behind domain ports + `ITransactionManager`,
  audit context, system-config REST surface, Identity/AuthN/AuthZ (opaque session
  tokens + scrypt + RBAC, QUE-43) landed. In-memory is dev/test default;
  `QMS_PERSISTENCE=postgres` → Postgres.
- **Frontends:** all Vite + React + TS PWAs (`caller` `/caller`, `kiosk`
  `/kiosk`, `tv` `/tv`, `admin` `/admin`+`/wizard`). Each PWA's
  `base`/`start_url`/`scope` align to its `/svc/` prefix. Shared design-token
  system + a11y/interaction baseline via generated vendored copies (QUE-37).
- **Deployment:** `docker-compose.yml` + per-service Dockerfiles + nginx
  `gateway` with first-run `auth_request` guard. `gateway` `depends_on
  core-api-service` with `condition: service_healthy`.
- **Acceptance:** DoD-1..5 specs in `services/core-api/test/acceptance/`, run via
  `npm run test:acceptance`. DoD-4 power-cut recovery/durability gate on
  `QMS_ACCEPTANCE_DB_URL`.

Per-ticket PR history (PR numbers, arch-review verdicts) is not kept here — see
git history and the Linear project.

## Working in this repo

Monorepo; each service owns its `package.json` + install, `node_modules`
gitignored. **A fresh worktree needs a per-service `npm install`** for every
service the root `npm run verify` gate touches (`core-api`, `admin-service`,
`tv-display-service`, `caller-service`, `kiosk-service`) before the gate runs.

`core-api` layout: `src/domain` (pure entities/VOs/aggregates/events/ports),
`src/application` (use cases), `src/infrastructure` (repo impls — in-memory
default, Postgres under `QMS_PERSISTENCE=postgres`), `src/interface-adapters`
(REST controllers / WS gateways). Repo interfaces are **ports defined in the
domain layer**; concrete impls live in infrastructure. Aggregate IDs are branded
types (e.g. `TicketId`); types shared across contexts (e.g. `PriorityPolicy`)
live in `src/domain/shared/`.

## Conventions & gotchas (by area)

The detailed gotchas live in auto-memory files (recalled on demand when you work
in that area). Each area's load-bearing essence:

- **core-api architecture** — dep-cruiser enforces Domain purity + layering;
  use cases inject only domain ports; the active `StateMachine` is supplied as
  an `ITransitionPolicyResolver` resolved **per execution** (boot must precede
  first-run config). → memory `core-api-architecture-gotchas`
- **Postgres persistence** — `PersistenceModule.forRoot()` profiles;
  `PostgresMigrationRunner` is the only schema authority; gap-free sequence
  reservation via `ITransactionManager`; `synchronous_commit=on` per connection
  via pool `onConnect` + `fsync=on` fail-fast probe (NFR-REL-02). → memory
  `postgres-persistence-gotchas`
- **Daily reset semantics & archive** — `archivePreviousDayData=true` relocates
  to `archived_tickets` before reset; archive+reset+audit in one tx; `audit_log`
  is never touched by cleanup; `MIN_RETENTION_DAYS` (7) is an application-layer
  guardrail. → memory `postgres-persistence-gotchas`
- **Identity & AuthN/AuthZ (QUE-43)** — opaque session tokens (NOT JWT) +
  `node:crypto.scrypt` (zero new deps); `node:crypto` behind domain ports; guards
  per-controller; endpoint classification (public / authenticated / admin-only);
  setup-admin self-gates on setup status; login dummy-verify side-channel. →
  memory `identity-auth-gotchas`
- **Realtime & queue command lifecycle** — `QueueEventDispatcher` (import via
  direct path, not the barrel); six commands drain events after `queue.save`;
  transfer emits 2 events, recall emits 2 (TICKET_CALLED re-shows on TV);
  generic transition rejects canonical targets. → memory
  `core-api-architecture-gotchas`
- **Domain value-object rules** — construction failures throw
  `InvalidValueObjectException` (never bare `Error`); `InvalidArgumentException`
  for use-case guardrails; declare module `const`s before a VO with a `static
  DEFAULT` (TDZ); relocate invariants when deleting a guardrail VO. → memory
  `core-api-architecture-gotchas`
- **REST surface separation** — read-only `RestApiModule`; mutation endpoints get
  per-concern modules (`TicketsApiModule`, `QueueCommandsApiModule`,
  `SystemApiModule`); use-case wiring in `QueueOperationsModule`; read use cases
  live in the bounded context that owns the entity. → memory
  `core-api-architecture-gotchas`
- **Reporting & analytics (FR-ADM-03)** — CQRS read side (`REPORT_QUERY_PORT` /
  `AUDIT_LOG_REPOSITORY`); lifecycle timestamp columns; denormalize a name the
  read model already JOINs, client-side join only a name it doesn't; SheetJS
  offline bundling (namespace-URI whitelist in `ALLOWED_HOSTS`); hand-rolled
  charts; range report (90-day use-case `InvalidArgumentException` pre-SQL);
  Dashboard (live REST poll) vs Analitik (historical) split. → memory
  `reporting-analytics-gotchas`
- **Admin/wizard client** — wizard PUT is a full save (carry new required fields
  as payload-only); friendly label maps (never raw enums); mirror core-api VO
  invariants in client-side validation with constrained inputs; client-only
  presets stripped at finalize; **category id-preservation is load-bearing**
  (send existing ids or orphan tickets); id↔code boundary mapping. → memory
  `admin-wizard-gotchas`
- **Gateway & deployment** — `gateway` `depends_on core-api-service` healthy +
  `/api/health` healthcheck; first-run `auth_request` guard (403
  `SETUP_REQUIRED`, never throw); `nginx -t` standalone DNS gotcha; topology
  smoke test tiers; `prdWizardPayload()` must carry every
  `REQUIRED_CONFIG_FIELDS` entry. → memory `gateway-deployment-gotchas`
- **Frontend service conventions** — PWA `base`/`scope` match NGINX route;
  injectable `WebSocketCtor` (jsdom has no global WS); providers own resource
  options (never a pre-built instance); React 18 batching; synchronous
  double-tap guard on touch surfaces; caller WS projections recover missing
  fields from local state; ARIA rules (`role="group"` not `option`, sibling
  `<label>`, `role="img"` on glyph spans); **draggable card with an interactive
  child** (button/stepper inside a card whose `onPointerDown` starts a drag) →
  `onPointerDown={(e) => e.stopPropagation()}` on the child, else the drag's
  `setPointerCapture` redirects `pointerup` to the card and the child's `click`
  never fires (real-browser-only — jsdom's `fireEvent.pointerDown` strips
  `isPrimary`/`button` and the global `PointerEvent` ctor is absent, so the bug
  is jsdom-undetectable; mirror the existing resize-handle stopPropagation).
  → memory `frontend-conventions-gotchas`
- **React Flow v12 (admin Alur Status Tiket designer)** — `onNodeClick` always
  fires (selection SOT via `onSelectionChange`); canvas-only derived fields on
  `FlowNodeData` (ISP); `markerEnd` object→string resolution + framework-free-lib
  `${MarkerType}` trick; `isValidConnection`↔`onConnectEnd` duplicate-feedback
  pairing; edge direction = START handle's TYPE not drag direction →
  `isConnectableStart={false}` on target handles (drop-only), and
  `ConnectionMode` is an enum not a literal union; **connection-handle
  discoverability is a three-tier opacity system, NOT hide-until-hover**
  (manager feedback "selalu tidak bisa menghubungkan"): RF stamps
  `connectionindicator` on valid drop-targets during a drag and `connectablestart`
  on source handles even in default mode — at-rest source handles `opacity:0.5`
  (gated on `.connectable` so read-only mode stays clean), full `opacity:1` on
  `:hover`/`.selected`/`.connectingfrom`/`.connectionindicator:not(.connectablestart)`
  (the drop-target reveal is the core fix), with an enlarged transparent
  `::before` hit area (inherits the handle's `pointer-events`); mind the
  specificity — hover/selected must be gated on `.connectable` to tie (0,4,0)
  the at-rest rule and win by source order, and the drop-target reveal's `:not()`
  lifts it to (0,5,0). → memory `frontend-conventions-gotchas`
- **TV board** — `QueuedAudioProvider` decorator over `SequencerAudioProvider`
  (drain single-flight guard is load-bearing, FIFO not interrupt); history
  retains on `COMPLETED` only (never `SKIPPED`/`WAITING`); idle = empty
  `NowServingCard` (standby promo overlay removed); disclaimer marquee distinct
  from removed promo. → memory `frontend-conventions-gotchas`
- **Shared design-token system** — generated vendored copies (canonical source
  + sync script + committed copies + drift gate), NOT a workspace package;
  light default / dark opt-in (QUE-47); `--accent` hex for runtime brandColor;
  `--accent-on-surface`/`--danger-on-surface` for text; `:where()` only for a
  shared baseline yielding to service overrides (never a service rule over its
  own base — plain attribute selector); runtime brandColor + theme mode via
  duplicated 4× `theme.ts` leaves; `ServiceThemes` JSONB VO. → memory
  `frontend-conventions-gotchas`
- **RTL/jsdom/css:false test mechanics** — fake-timer query/click patterns,
  re-query DOM after step re-entry, `toHaveClass('--hidden')` never
  `toBeVisible()`, static CSS guards via `node:fs`, skeleton a11y recipe. →
  memory `frontend-rtl-test-gotchas`
- **Jest/vitest + build quirks** — `testMatch` negation for acceptance gating,
  `mock.invocationCallOrder` order, `jest.restoreAllMocks` + `vi.hoisted`
  accumulator reset, TS literal-widening (`as const`), `defineConfig` from
  `vitest/config`, `tsc -b` composite artifacts gitignore, TS re-export binding. →
  memory `jest-vitest-test-quirks`

## General

- When adding a feature, map it to the relevant FR-* / NFR-* requirement in the
  PRD and the bounded context it belongs to. Preserve the interface boundaries
  (e.g. don't leak admin DTOs into `ICallerApi`).
- Tests: include `InMemoryQueueRepository`-based unit tests for use cases;
  integration tests must run without internet.

## Linear integration

Create/triage issues against the **Queue System** team (key `QUE`), project
**Enterprise Offline Queue Management System (QMS)**. Use the
`product-manager` agent for ticket lifecycle and the `linear-*` skills
(`linear-create-issue`, `linear-bug`, `linear-techdebt`) for new work.

- **API gotcha:** `list_projects` with multiple `include*` flags raises a
  "query too complex" 400. Instead, `list_projects` filtered by `team` +
  `query:"QMS"`, then `get_project` (by name) for the full description.
- **Ticket lifecycle convention:** move a ticket to **In Progress** once its
  plan is approved (before coding begins), and to **In Review** when its PR is
  opened. Attach the PR link to the Linear issue.
- **Branch naming:** `<type>/que-<n>-<slug>` where `<type>` ∈
  `feat`/`fix`/`refactor`/`chore`. This overrides Linear's suggested
  `franssiswanto/que-…` branch name.