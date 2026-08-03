# CLAUDE.md — Enterprise Offline Queue Management System (QMS)

> Source of truth: the Linear PRD under the **Queue System** team, project
> "Enterprise Offline Queue Management System (QMS)". When this file and the
> PRD disagree, the PRD wins — update this file to match.

## What this is

An **offline, on-premise queue management system** for a single branch/store.
It runs 100% on a local LAN — **no internet, no cloud, no external CDN/API calls
at runtime**. Visitors take tickets at a kiosk, staff call them from a counter
panel, and a TV display shows the now-serving number with sequential audio
announcements. A manager administers categories, counters, the queue state
machine, and daily-reset policy via an admin panel + first-run setup wizard.

Linear project: Queue System team (key `QUE`).

## Architecture

Single-host deployment: every service is a Docker container on **one** local
PC server, fronted by an NGINX reverse proxy (`gateway`, ports 80/443). Bring
the whole stack up with one command:

```
docker compose up -d
```

### Services (monorepo, one container each)

| Service | Stack | Internal port | External endpoint | Responsibility |
|---|---|---|---|---|
| `gateway` | NGINX Alpine | 80, 443 | `http://antrian.local/` | Reverse proxy, static assets, SSL termination, first-run wizard routing |
| `core-api-service` | Node.js (NestJS/Express) or Go | 3000 | `/api/*`, `/ws` | Business logic, state machine, dynamic routing engine, WebSocket server, DB persistence |
| `kiosk-service` | React / Next.js / Vue | 3001 | `/kiosk` | Visitor touchscreen ticket UI + silent thermal printing |
| `tv-display-service` | React / HTML5 Audio API | 3002 | `/tv` | TV queue board + offline audio synthesizer |
| `caller-service` | React / Web PWA | 3003 | `/caller` | Counter staff panel, dynamic action buttons from state machine |
| `admin-service` | React / Next.js | 3004 | `/admin`, `/wizard` | Manager control panel, setup wizard, analytics, master data |
| `db-service` | PostgreSQL 15 / SQLite | 5432 | internal only | Queue transactions, system config, audit trail |

### Clean Architecture (in `core-api-service`)

Layers, outside-in: **Infrastructure** (Express/Fastify, Postgres, WS) →
**Interface Adapters** (Controllers, Presenters, Repositories) →
**Application / Use Cases** (`CreateTicketUseCase`, `CallNextTicketUseCase`,
`ResetDailyQueueUseCase`) → **Domain** (Entities, Value Objects, Aggregates,
Domain Events).

**Hard rule (NFR-MNT-01):** the Domain layer must have **zero** dependencies on
ORM, HTTP framework, or I/O libraries. High-level modules depend on
abstractions (interfaces), never concrete infrastructure — see SOLID/DIP below.

### SOLID mapping

- **SRP** — each UI service owns one concern: `tv-display-service` renders +
  audio only; `kiosk-service` owns ticket printing only.
- **OCP** — `AudioProvider` (in `tv-display-service`) is an interface; add
  providers (MP3 fragment sequencer, offline TTS) without touching the TV
  store. `QueuedAudioProvider` decorates any `AudioProvider` to serialize whole
  announcements one-at-a-time FIFO so back-to-back `TICKET_CALLED` events never
  overlap (FR-TV-02).
- **LSP** — `IQueueRepository` is implemented by `PostgreSQLQueueRepository` and
  `InMemoryQueueRepository` (tests); they must be interchangeable.
- **ISP** — `caller-service` consumes only `ICallerApi`; never leak admin/reporting DTOs to it.
- **DIP** — Use cases & domain depend on interfaces, not the ORM/DB directly.

## Domain model (DDD bounded contexts)

Three bounded contexts:

- **Queue** — `QueueTicket` aggregate (`TicketId` UUID, `ticketNumber` e.g.
  "A-001", `categoryId`, `currentStatus`, `counterId`, timestamps). Events:
  `TicketCreatedEvent`, `TicketStatusChangedEvent`, `DailyQueueResetEvent`.
- **Store Config** — `SystemConfiguration` aggregate
  (`isInitialSetupCompleted`, `storeName`; VOs `StateSchema`,
  `StateTransitionRule`, `DailyResetPolicy`) and `CounterRoutingRule`
  aggregate (`counterId`, `assignedCategoryIds`, `priorityPolicy` ∈
  {`FIFO_GLOBAL`, `CATEGORY_PRIORITY`}).
- **Notification** — handled entirely in `tv-display-service` (no `core-api`
  domain model): the audio playback queue (`QueuedAudioProvider` over
  `SequencerAudioProvider`) and the display state projection in `tv-store`.
  Audio is a pure client concern — the backend never plays sound — so no
  domain `AudioProvider`/`AudioQueueItem` is warranted (no speculative ports;
  an earlier `domain/notification` stub was removed as dead code). Adding a
  server-side audio model would be over-abstraction.
- **Reporting** — `DailyQueueReport`, `CounterPerformance`.

Default state machine: `WAITING → CALLING → SERVING → COMPLETED`, plus
`SKIPPED` (reachable from `CALLING`, returns via "Panggil Ulang"). Custom
states (`PREPARING`, `PAYMENT`, …) are configurable via the wizard; each
transition carries an `action_label` that becomes a Caller UI button.

**Transfer Queue** ("pindah kategori", FR-CLR-03) is modeled as a first-class
**configurable transition**, not a special case: the `TransferTicketUseCase`
validates `currentStatus → targetStatus` (default `WAITING`) against the
active `ITransitionPolicy` like any other transition, then reassigns the
category and reissues a per-category ticket number (clearing the counter). The
PRD §7 default state machine has no transfer edge, so transfer is rejected
with `InvalidStateTransitionException` until the wizard adds one (e.g.
`CALLING → WAITING` labelled "Pindah Kategori"). The use case pre-checks
before reserving the new number so an illegal transfer burns no sequence
(NFR-REL-02).

The full reference config JSON (store name, daily_reset, state_machine,
categories, routings) lives in PRD §7 — read it before touching config code.

## Hard constraints (do not violate)

- **No internet at runtime (NFR-REL-01).** All assets — JS, CSS, fonts, audio
  MP3s, DB drivers — are served from the local PC server. Never add an external
  CDN link, `<link>`/`<script src="https://…">`, or remote API call to runtime
  code. Bundling must inline/vendor everything.
- **Power-loss resilient (NFR-REL-02).** Use PostgreSQL/SQLite with WAL. After
  an unexpected power cut, ticket numbers and transaction state must recover
  exactly — no duplicates, no gaps. Design writes so a crash mid-operation
  leaves the DB consistent.
- **Container self-healing (NFR-REL-03).** Every service in `docker-compose.yml`
  uses `restart: always`.
- **Latency budgets.** Internal HTTP API p99 < 100 ms
  (NFR-PERF-01). WebSocket caller→TV round trip < 150 ms on LAN
  (NFR-PERF-02). Kiosk physical print < 1.5 s after touch
  (NFR-PERF-03). Don't add work to the hot path that threatens these.
- **Local network only (NFR-SEC-01).** App access is restricted to the store LAN
  subnet.
- **Audit trail (NFR-SEC-02).** Manual reset, state-schema changes, and routing
  changes must be written to the local audit log.
- **Clean architecture layering (NFR-MNT-01).** Domain has no framework/ORM/IO
  imports — enforce this; a static-analysis check is an acceptance criterion.

## Project status / milestones

Project is in **Backlog**, PRD status **Final Draft** — no code yet. Milestones
(Linear), in order:

1. **Foundation & Architecture** — deployment, persistence, offline single-host setup.
2. **Core Queue Workflow** — queue engine, state transition, routing, realtime events, daily reset.
3. **Operational Interfaces** — kiosk, caller panel, TV display, audio engine, admin operations.
4. **Hardening & Acceptance** — audit trail, analytics, resilience tests, offline E2E verification.

Definition of Done (PRD §8): static analysis proves the Domain layer is
dependency-free; first-run wizard redirects a clean browser to `/wizard` and
completes the 4 steps; full flow (kiosk ticket → thermal print → caller → TV
audio/display) works with WAN cable unplugged; power-cut recovery test passes
with no duplicate/lost ticket numbers.

## Repo state

- **Git initialized** — remote `monosolusi/queue-flow`, default branch `main`.
  The `services/core-api/` NestJS project and its Clean Architecture domain
  layer are merged (QUE-8, PR #1); QUE-12 added the local WebSocket broadcaster;
  QUE-10 added the state-transition validator + queue action use cases (merged,
  PR #4). QUE-19 (merged, PR #5) scaffolded `services/caller-service/`
  (Vite + React + TS PWA) and added core-api's first read-only REST surface
  (`GET /api/counters`, `GET /api/queue?counterId=N`). QUE-9 (merged, PR #6)
  added ticket generation: `CreateTicketUseCase` + `POST /api/tickets`
  (per-category, per-day `A-001` sequence via `ISequenceRepository`). QUE-17
  (In Review, PR #7) scaffolded `services/kiosk-service/` (Vite + React + TS PWA,
  the visitor touchscreen kiosk, port 3001 at `/kiosk`) and added
  `GET /api/categories` (`ListCategoriesUseCase`) for the kiosk category-select
  screen. QUE-2 wired the queue engine end-to-end: the six command use cases
  now resolve the active policy per execution via `ITransitionPolicyResolver`
  and drain/broadcast their lifecycle events, the daily-reset engine
  (`ResetDailyQueueUseCase` + `POST /api/system/daily-reset` + boot-armed
  `DailyResetSchedulerService`) emits `SYSTEM_RESET`, and
  `QueueCommandsApiModule` exposes the caller command REST surface. QUE-30
  (Hardening & Acceptance, PR #9) landed the rest of the stack: PostgreSQL
  persistence behind the domain ports + `ITransactionManager` (WAL-durable,
  NFR-REL-02), the `audit` bounded context (NFR-SEC-02), the system-config REST
  surface (`GET/PUT /api/system/config`, `GET /api/system/state-machine`,
  `GET /api/health`) + wizard/state-machine read use cases, `admin-service`
  (first-run wizard PWA, `/admin`), `tv-display-service` (queue board + audio
  sequencer, `/tv`), caller dynamic action buttons, kiosk thermal print
  provider, `docker-compose.yml` + per-service Dockerfiles + the nginx gateway,
  and the DoD-1..4 acceptance suite (`services/core-api/test/acceptance/`). The
  in-memory profile stays the dev/test default; `QMS_PERSISTENCE=postgres`
  activates the Postgres profile (DoD-4 verifies power-cut recovery against a
  real Postgres). QUE-22 (Operational Interfaces, parent QUE-4, FR-TV-02 /
  NFR-REL-01) hardened the TV audio path: the fragment sequencer
  (`SequencerAudioProvider`, landed under QUE-30) is now wrapped in a
  `QueuedAudioProvider` — an announcement-level FIFO queue (decorator over the
  `AudioProvider` interface) so back-to-back `TICKET_CALLED` events play
  strictly one-at-a-time with no inter-call overlap (the QUE-30 scaffold only
  serialized fragments *within* one announcement and fire-and-forgot each
  call, so two rapid calls overlapped). `buildCallFragments` now decomposes the
  counter id digit-by-digit too, so a counter ≥ 10 reuses the existing
  `0-9.mp3` assets instead of silently dropping (there is no `10.mp3`).
  `tv-store` calls `audio.stop()` on `SYSTEM_RESET` and on unmount to drain
  stale queued announcements. The orphaned `core-api` `domain/notification`
  stub (a second, divergent `AudioProvider`/`AudioQueueItem` with no use case
  or importer) was removed — audio is a pure client concern, no domain model
  is warranted. QUE-26 (Hardening & Acceptance, FR-ADM-03) landed the
  daily-analytics + local-export reporting read side: lifecycle timestamp
  columns on `tickets`/`archived_tickets` (`called_at`/`served_at`/
  `completed_at`), the Reporting CQRS read side (`IReportQueryPort` +
  in-memory/Postgres impls) with `GET /api/reports/daily` +
  `GET /api/reports/counters/:id`, the audit-trail read surface
  (`GET /api/audit/log`), and the `admin-service` analytics dashboard
  (`/analytics`) with offline SheetJS `.xlsx` export (DoD-5 acceptance spec).
  Remaining Hardening work: re-arming the daily-reset cron on wizard config
  change, backend cron-format enforcement, and a `DAILY_RESET_POLICY_CHANGE`
  audit action — landed as QUE-32 (Hardening, parent QUE-6; was blockedBy
  QUE-25, pairs with audit). QUE-25 (manual reset admin button + transaction-log
  cleanup) was the last QUE-6 child before QUE-32.
  **QUE-6 closure (Hardening umbrella, FR-ADM-03 "Grafik Rekapitulasi
  Harian"):** all four QUE-6 children (QUE-24/25/26/32) merged with the
  umbrella's own AC met, but a genuine PRD gap remained — FR-ADM-03 literally
  specifies "Grafik rekapitulasi harian" (daily recap *charts*) for Total
  Pengunjung / rata-rata waktu tunggu / rata-rata waktu layan, and QUE-26's
  dashboard rendered metric *tiles* + *tables* only (no visualization anywhere
  in the repo — zero `<svg>`, no chart lib in any `package.json`). Per the
  residual-gap-polish-over-closure pattern, QUE-6 (still open) owned the
  residual and closed with it rather than reflexively closing. The polish
  added `RecapCharts` (`admin-service/src/components/RecapCharts.tsx`) — three
  hand-rolled offline SVG bar charts (one per metric, one bar per category)
  inserted between the Ringkasan tiles and the Per Kategori table, fed
  entirely by the existing `DailyReportDto.perCategory` slice. **General
  rule: hand-roll small visualizations from the DTO the page already loads
  rather than vendoring a chart library** (Recharts/d3 would bloat the bundle
  for a 2–3-bar chart and would need offline vetting, NFR-REL-01) — mirroring
  the audio-sequencer minimal-dependency precedent. Single-series magnitude →
  one accent hue (`--accent`) for all bars, length encodes value, category
  code labels it (no categorical color needed; the dataviz method's sequential
  default); text never wears the data color (labels in `--text`/`--text-muted`);
  per-bar `<title>` is the hover/a11y channel; the sibling Per Kategori table
  is the always-available table view. `formatSeconds` was extracted to a
  shared `lib/format.ts` (DRY — the chart's value labels must match the
  table's "Rata Waktu" cells exactly). **admin-service only — no core-api /
  domain / REST change** (the report DTO already carried the chart input).
  Test note: SVG `<text>` category-code labels collide with the Per Kategori
  table's `<td>` under `getByText('A')` — scope such assertions to the region
  (`getByRole('region', { name: 'Per kategori' })` + `within`) when a chart
  and a table render the same code, and assert the chart's `aria-label`
  summary (it carries the formatted values, so it catches a zero-width-bar
  regression a testid-presence check cannot).
  The frontend PWA `base`/`start_url`/`scope` alignment (`/kiosk/`, `/tv/`,
  `/caller/`, `/admin/`) is complete across all four services (QUE-27).
  QUE-20 (Operational Interfaces, parent QUE-5, FR-CLR-02/03) is the caller
  dynamic action controls ticket. Its stated AC was already met by the
  `ActionControls` component landed under QUE-30 (fetches
  `GET /api/system/state-machine`, renders one button per outgoing edge for
  the active ticket's status, fire-and-forgets commands whose WS events update
  the store). QUE-20 (In Review, PR #22) is a focused **polish** PR closing the
  two genuine residual PRD gaps QUE-30 left: (1) the "Pindah Kategori"
  transfer (FR-CLR-03) silently auto-picked a destination — and when the
  counter served only the active ticket's category it fell back to
  `assignedCategoryIds[0]`, i.e. transferred to the *same* category; the
  chooser now lists the bound counter's *other* categories by name (≥2 →
  inline chooser, 1 → direct fire, 0 → disabled "tidak ada kategori lain"),
  with a legacy id-only fallback for a stale binding; (2) a custom-target
  transition (an edge to a state outside the 5-state command map, e.g.
  `PREPARING`) was silently `return null`'d — it now renders a visible
  disabled "(belum didukung)" affordance so every configured transition still
  produces a button (the PRD says each transition's `actionLabel` becomes a
  Caller UI button). An enabling micro-fix preserved `categoryId` on the
  `TICKET_CALLED` projection (the wire payload carries only
  `{ ticketNumber, counterId }`; the store now recovers it from the prior
  waiting entry) so the chooser's "exclude current category" works on the live
  call-next path. **No core-api/domain change** — caller-service only.
  **QUE-33** (Core Queue Workflow, parent QUE-5, relatedTo QUE-20 + QUE-10) is
  the follow-up: a generic `apply-transition` core-api endpoint + use case so
  custom-target transitions fire a real command instead of rendering
  disabled (not blocked by QUE-20; it supersedes the disabled affordance
  independently).
- **PRD language:** the Linear PRD is written in **Bahasa Indonesia** with
  English technical terms. UI `action_label` values ("Panggil Berikutnya",
  "Lewati / Absen", "Selesai Layan") are Indonesian — match them verbatim
  when wiring the state machine.

## Working in this repo

- The repo is a monorepo; each service lives in its own directory (e.g.
  `services/core-api/`, `services/kiosk/`). Establish this layout when
  scaffolding starts if no structure exists yet.
- Backend stack for `core-api-service` is **NestJS + TypeScript** (decided in
  QUE-8, 2026-07-30 — the PRD left Node.js/NestJS vs Go open). The monorepo is
  TypeScript throughout (frontends are React-family TS). The Domain layer
  (`src/domain/**`) is pure TypeScript with zero framework/ORM/IO imports; the
  Clean Architecture layering rules apply identically.
- `core-api` internal layout: `src/domain` (pure, framework-free entities/VOs/
  aggregates/events/ports), `src/application` (use cases), `src/infrastructure`
  (repo implementations — `persistence/in-memory/` now, PostgreSQL later),
  `src/interface-adapters` (REST controllers / WS gateways, added later).
  Repository interfaces are **ports defined in the domain layer**; concrete
  implementations live in infrastructure.
- Domain purity is enforced by **dependency-cruiser** — run
  `npm run arch:check` from `services/core-api`. It forbids `src/domain/**`
  from importing any ORM/HTTP/IO library (NFR-MNT-01) and forbids the Queue
  bounded context from importing Store Config internals (anti-corruption). It
  also forbids `src/application/**` from importing `src/infrastructure/**`
  (`application-no-infrastructure`) so use cases depend on domain ports, never
  concrete repos (DIP). Types shared across bounded contexts (e.g.
  `PriorityPolicy`) live in the shared kernel `src/domain/shared/`. Aggregate
  IDs are branded types (e.g. `TicketId`) to prevent cross-aggregate ID
  confusion.
- **Use-case conventions** (`src/application/**`): a use case injects only
  domain **ports** (interfaces) — e.g. `IQueueRepository`,
  `ICounterRoutingRuleRepository`, `ITransitionPolicyResolver` — never
  infrastructure concretions. It returns a transport-agnostic **DTO**
  (discriminated-union result), never the aggregate itself, so the
  interface-adapter layer maps it to HTTP/WS. Command + result DTOs are
  co-located with the use case. The active `StateMachine` (from
  `SystemConfiguration`) is supplied to the use case as an
  `ITransitionPolicyResolver` (a domain port, `TRANSITION_POLICY_RESOLVER`
  Symbol token) by the interface-adapter/DI layer — **not** a snapshot
  `ITransitionPolicy` and **not** loaded by the use case. Each use case
  resolves the active policy per execution (`const policy = await
  resolver.getActivePolicy();`) and passes the **synchronous**
  `ITransitionPolicy` into the aggregate's transition methods. Per-execution
  resolution is required for two reasons: (1) the app must boot **before** the
  first-run wizard creates `SystemConfiguration`, so resolving a policy
  eagerly at boot would throw `SystemNotConfiguredException` and crash startup
  (and break the wizard itself, which needs the app running to serve
  `/wizard`); (2) `QueueTicket.transitionTo` is synchronous `void` and calls
  `policy.isAllowed` inline + throws, so a lazy async proxy is not viable — the
  use case must hand the aggregate a fully-resolved sync policy. The
  `StateTransitionValidator` (interface-adapter) implements the resolver port,
  reading the singleton `SystemConfiguration` and yielding its `StateMachine`;
  all queue command use cases share this one resolver.
- **dep-cruiser resolution gotcha:** `arch:check` flags a bare import as
  `not-to-unresolvable` when the package's `package.json` `exports` field has no
  `default` condition (e.g. `ws`). Either add `conditionNames` to
  `enhancedResolveOptions` in `.dependency-cruiser.cjs`, or don't import the
  package directly in `src/` — depend on `@nestjs/*` wrappers or local
  structural types instead (the WS gateway does the latter). **`to.path` regex
  anchor:** dep-cruiser resolves a bare specifier to `node_modules/<pkg>/…`, so
  a `forbidden.to.path` rule anchored `^(@nestjs/.*)` is a **silent no-op** — it
  never matches the resolved path. Anchor against `node_modules/`, e.g.
  `^(node:)?(node_modules/)?(@nestjs/.*|pg|typeorm|…)` (the
  `domain-no-framework-imports` and `application-no-framework-imports` rules
  both use this form). A rule that "passes" while a known framework import sits
  in `src/` is a red flag — verify a forbidden rule actually catches by
  temporarily adding the bad import before trusting it.
- **NestJS DI for interface ports:** `interface` ports (`IQueueRepository`,
  `IQueueEventPublisher`, …) are erased at runtime, so NestJS can't resolve
  them by type metadata. Inject each via a co-located Symbol token + `@Inject`
  (see `QUEUE_EVENT_PUBLISHER` in `event-publisher.port.ts`), and bind it in the
  module with `{ provide: <token>, useClass: <impl> }`. **`useClass` vs
  `useFactory` for Symbol-bound deps:** `useClass: X` makes NestJS resolve
  `X`'s constructor params by their *type token*. If a param is a class whose
  only provider is bound to a **Symbol** (e.g. the `pg.Pool` bound to
  `PG_CONNECTION`), there is no class-token provider for `Pool` and DI throws
  `Nest can't resolve dependencies of X (?)` at boot. Wire such repos through a
  factory that injects the Symbol: `{ provide: <repo-token>, useFactory: (pool)
  => new X(pool), inject: [PG_CONNECTION] }`. The in-memory repos have no-arg
  constructors so `useClass` is fine for them; the Postgres repos (which take
  `pool: Pool`) all use `useFactory`. This class of failure is invisible when no
  test boots the profile — the Postgres profile only boots under
  `QMS_PERSISTENCE=postgres` (DoD-4), so a wiring bug ships silently until CI
  sets the env var.
- **Realtime stack (QUE-12):** the WS gateway uses `@nestjs/platform-ws`
  (`WsAdapter`) and shares the HTTP port at path `/ws` (a gateway with no
  explicit port binds `noServer` onto the HTTP server's `upgrade` event). The
  app boots on `@nestjs/platform-express` — both platform packages must stay
  installed or `NestFactory.create` fails with "No driver (HTTP) has been
  selected."
- **Ticket generation & daily sequence (QUE-9):** the kiosk takes a ticket via
  `POST /api/tickets` → `CreateTicketUseCase`, which resolves the category,
  reserves a per-category, per-day number (`A-001`) from the
  `ISequenceRepository` port (atomic — no dupes/gaps, NFR-REL-02), mints a
  `QueueTicket` (WAITING), persists, and broadcasts `TICKET_CREATED`. The daily
  sequence key is `YYYY-MM-DD` in the store's **local** time (not UTC — single
  on-premise box, NFR-SEC-01), owned by the **application layer** (a pure
  `toDateKey(epochMs)` helper) and derived from an injected `clock` so the date
  convention stays out of the pure domain and is testable. The
  `ISequenceRepository` port carries a `SEQUENCE_REPOSITORY` Symbol DI token
  like the other repo ports. True gap-free durability (reserve + insert in one
  DB transaction) is the future PostgreSQL repo's job (QUE-28) — the in-memory
  impl is tests/dev only.
- **Admin operational config panel (QUE-24, FR-ADM-01):** post-setup the
  manager edits categories, counter routing, and the daily-reset policy in
  place at `/admin` (the read-only dashboard became a sectioned editor); the
  wizard stays the guided first-run and the editor for `storeName` + the state
  machine. It reuses the existing audited `PUT /api/system/config` full save
  (DRY — no new REST surface, no duplicated audit/tx wiring): GET the full
  config, edit the in-scope sections, **passthrough** unchanged `storeName` +
  `stateMachine`, PUT the full payload back. **Category id-preservation is
  load-bearing:** `QueueTicket.categoryId` stores the category UUID, and
  `SaveSystemConfigurationUseCase.buildCategories` reuses a provided `id`
  (`Identifier.of(id)`) but regenerates it when `id` is absent — so any client
  re-editing categories post-setup MUST send the existing `id` for unchanged
  categories (omit it only for newly added ones), or it mints new ids and
  orphans every existing ticket's `categoryId`. (The wizard re-edit prefill
  previously dropped ids and routing assignments — a latent bug QUE-24 fixed.)
  **Client boundary id↔code mapping:** `GET /api/system/config` returns
  routing `assignedCategoryIds`, but `PUT` expects `assignedCategoryCodes` —
  the admin/wizard client maps id→code on load (via the categories' id→code
  map) and sends codes; the backend resolves codes→ids at save.
  `Identifier.of` only accepts a v4 UUID (`Identifier.isValid`), so
  fixtures/payloads must use real v4 UUIDs, not arbitrary slugs like
  `'cat-a'`. Scheduler re-arm on reset-policy change is still deferred to the
  Hardening milestone (cron/mode changes take effect on next restart);
  categories/routing take effect immediately via per-execution policy
  resolution.
- **Wizard state-machine designer step (QUE-15, FR-WZD-04):** the wizard's
  step 3 lets the manager pick the PRD §7 default state machine or build a
  custom one. The default/custom choice is a **client-only preset** — a
  `mode: 'default' | 'custom'` field on the wizard's state-machine form slice
  that is **never sent to core-api** (the `PUT /api/system/config` payload is
  always the full `{ states, transitions }` graph; `mode` is stripped in
  `finalize` and force-resets to the PRD §7 default when `'default'`, so a
  half-edited custom graph a manager abandoned cannot leak onto the wire — no
  `StateMachineDto` contract drift). It is inferred on prefill by structural
  deep-equal against `DEFAULT_STATE_MACHINE`. In custom mode the `states` list
  is editable (add/remove) and each transition's `from`/`to` are **`<select>`
  dropdowns constrained to the current `states` list** — this structurally
  prevents the backend `StateMachine` ctor's `transition references states not
  in the schema` 400 (the manager can only pick existing states). A state
  referenced by any transition cannot be removed (`Hapus` disabled), and
  renaming a state propagates to every transition that referenced the old name
  (no dangling edge). **Client validation mirrors the backend:** the wizard's
  `validateCustomStateMachine` mirrors `StateSchema.of` (≥1 state, non-empty
  unique names) and `StateMachine` ctor (≥1 transition, `from`/`to` ∈ schema,
  no duplicate `from->to` edges, non-empty `actionLabel`) invariants, and
  `Lanjut` is disabled on step 3 while invalid — so the wizard never submits a
  graph the backend would reject. **General rule for the admin/wizard client:**
  mirror core-api value-object invariants in client-side validation AND use
  constrained inputs (dropdowns over the live list) to make invalid states
  unconstructable, rather than relying on a backend 400 round-trip. The
  routing-matrix step (FR-WZD-03) was already satisfied by the existing
  per-counter checkbox matrix; QUE-15 touched only step 3.
- **Wizard daily-reset step + finalization (QUE-16, FR-WZD-05/06):** the
  wizard's `archivePreviousDayData` flag was stored but **inert**; QUE-16 wires
  the reset engine to honor it and adds a finalization review step. **Archive
  semantic:** `true` (default) relocates every ticket in the active store with
  `created_at < startOfLocalDay(now)` into a new `archived_tickets` table
  *before* the sequence reset (regardless of status — "active" = "in the active
  table", not "non-terminal"); `false` is a **no-op**, not a purge (the AC says
  "arsipkan"). A dedicated **`ITicketArchivePort`** (one method, `domain/queue`)
  is added on ISP grounds — the reset use case needs only the archive op, not
  the full `IQueueRepository` surface. The concrete queue repos implement
  **both** ports; NestJS binds `TICKET_ARCHIVE_PORT` via
  `useExisting: QUEUE_REPOSITORY` (works for `useClass` and `useFactory`
  bindings — one repo instance serves both tokens). **Anti-corruption preserved:**
  `ResetDailyQueueUseCase` stays Store-Config-free; `SystemAdminController` and
  `DailyResetSchedulerService` read `DailyResetPolicy.archivePreviousDayData`
  and thread the scalar `archivePreviousDay: boolean` into the command, exactly
  the existing `resetTo` pattern. **Atomicity (NFR-REL-02):** archive + reset +
  (manual) audit all run inside one `txManager.runInTransaction(...)` callback;
  the `SYSTEM_RESET` event dispatches **after** commit (a rolled-back reset is
  never broadcast). The Postgres archive is a single `WITH moved AS (DELETE …
  RETURNING …) INSERT … SELECT` CTE enlisting on the ambient `AsyncLocalStorage`
  client. **Audit:** `AuditAction.ARCHIVE_PREVIOUS_DAY` is recorded **manual path
  only** (`command.actor` set), mirroring `MANUAL_RESET` scoping — the automatic
  cron reset is not audited. **`startOfLocalDay(epochMs)`** (local-midnight epoch)
  lives in `application/queue/create-ticket.use-case.ts` next to `toDateKey`,
  keeping the date convention out of the domain; the archive threshold is
  `created_at < startOfLocalDay(now)` (no `date_key` column — avoids
  timezone-fragile SQL). **In-memory rollback caveat:** `NoOpTransactionManager`
  is a pure pass-through, so `InMemoryQueueRepository.archiveTicketsBefore` does
  NOT roll back on a `resetDaily` throw (the Postgres impl does) — the in-memory
  impl is explicitly **not** an LSP substitute on the archive+reset failure path
  (documented dev-only limitation; gap-free durability is the Postgres repo's
  job). **Client cron validation:** `validateCronExpression` (pure helper in
  `admin-service/src/lib/cron.ts`) validates a 5-field cron (star / numbers /
  comma lists / ranges / steps; no named months/days) so the wizard + admin
  panel never submit an expression the boot-time `CronJob` would reject — the
  backend `DailyResetPolicy` VO only checks non-empty when
  `mode === AUTOMATIC_CRON`; backend cron-**format** enforcement is deferred to
  Hardening (pairs with scheduler re-arm). It gates the wizard step-4 `Lanjut`
  and the admin `Simpan Konfigurasi` button (single source of truth). **Wizard
  step 5 (FR-WZD-06):** a read-only review of the whole assembled form (store
  name, categories, routing, state machine, daily reset) renders from the
  in-memory form (no API call); the `Simpan & Aktifkan` (`wizard-finalize`)
  button now lives here — `TOTAL_STEPS` is 5. `finalize()` is unchanged (the
  payload already strips `mode` + nulls cron). **Default policy gotcha:** the
  default `DailyResetPolicy` has `archivePreviousDayData = true`, so
  `POST /api/system/daily-reset` **always** returns `archivedCount` in its
  result DTO (0 when no prior-day tickets) — the integration spec's `toEqual`
  must include it, and a manual reset now records **two** audit entries
  (`ARCHIVE_PREVIOUS_DAY` then `MANUAL_RESET`), not one. **Deferred:** backend
  cron-format enforcement and scheduler re-arm on policy change (still
  Hardening, pairs with audit-trail analytics surface).
- **Wizard store-profile + category step (QUE-14, FR-WZD-02):** the wizard's
  step 1 is "Profil Toko & Kategori" — store name + **active counter count** +
  categories with a **PRD §7 Default / Custom preset** (mirrors the QUE-15
  state-machine `mode` pattern: a client-only `categoriesMode: 'default' |
  'custom'` on the form, stripped at finalize, inferred on prefill by
  deep-equal against `DEFAULT_CATEGORIES` in `admin-service/src/api/types.ts`
  — `A=Customer Service`, `B=Kasir & Pembayaran`). Step 2 is the routing
  matrix only (assign categories + priority per counter); the counter count
  is owned by step 1 via `setCounterCount`, which syncs `routingRules` length
  (append default-named counters / truncate, **no renumber** — preserves
  counter identity) and clamps `>=1`. **Id-preservation is load-bearing and
  diverges from the state-machine pattern:** the state-machine force-reset can
  blindly use `DEFAULT_STATE_MACHINE` because the graph carries no ids, but
  `QueueTicket.categoryId` stores the category UUID, so the default-mode
  force-reset (`defaultCategoriesWithIds`, called from the default radio
  `onChange` and `finalize`) MUST draw its id pool from the **prefill**
  (`loadedCategoriesRef`, the categories as originally loaded with their
  persisted ids), NOT the live `form.categories` — otherwise a custom detour
  that removes a row, then switches back to default, would mint fresh UUIDs
  and orphan every ticket that referenced the removed code. The prefill-pool
  keeps the original ids across any custom round-trip. **`setCounterCount`
  uses `max(existing counterId)+1`, not `length+1`** — a re-edit can load a
  gapped/non-sequential set of counterIds and `length+1` would collide (the
  backend `buildRoutingRules` rejects duplicate counterIds with a 400).
  **Client validation mirrors the backend `Category` VO**
  (`validateCustomCategories`: code `^[A-Z]+$`, non-empty name, no dupes; per-row
  error prefixes so the dedup `Set` keeps distinct rows distinguishable) and
  gates step-1 `Lanjut`. Store-name validation stays backend-side (existing
  behavior; out of scope). No core-api change — the PUT contract already
  accepted the category list; the restructure is admin-service client only.
- **REST surface separation:** the read-only caller workspace surface
  (`GET /api/counters`, `GET /api/queue`) lives in `RestApiModule` (QUE-19).
  Mutation endpoints get their own module by concern — the kiosk
  ticket-creation surface is `TicketsApiModule` (`POST /api/tickets`), kept
  separate so the read-only module's purpose stays clean (SRP). Caller command
  endpoints (`POST /api/queue/call-next`, `…/:id/serve|complete|skip|recall`,
  `…/:id/transfer`) landed in QUE-2 under `QueueCommandsApiModule`
  (`@Controller('api/queue')`, sharing the `api/queue` prefix with the read-only
  `QueueController` — reads + commands under one resource prefix, commands as
  POST sub-paths). The system-admin daily-reset surface
  (`POST /api/system/daily-reset`) is its own `SystemApiModule` (SRP). The
  use-case **wiring** for all seven queue/system use cases is factored into one
  `QueueOperationsModule` (application layer, no controllers) — it imports
  `PersistenceModule` + `RealtimeModule` + `SystemConfigModule` and provides
  each framework-free use case via a factory injecting the repo tokens +
  `QueueEventDispatcher` + `TRANSITION_POLICY_RESOLVER`; the API modules then
  import it for the use-case class tokens. `SystemConfigModule` binds the
  `TRANSITION_POLICY_RESOLVER` port to `StateTransitionValidator`
  (injecting `SYSTEM_CONFIGURATION_REPOSITORY`).
  **Read use cases live in the bounded context that owns the entity they
  read:** `ListCategoriesUseCase` (`GET /api/categories`, QUE-17) lives in
  `application/queue` because `Category` is a Queue-context entity, and it joins
  the read-only `RestApiModule` — even though categories are also referenced by
  `CounterRoutingRule` in Store Config, the read stays in its owning context
  and does **not** join routing data (anti-corruption).
- **Kiosk ticket flow (QUE-17) + receipt (QUE-18):** the kiosk takes a category
  via `GET /api/categories`, then `POST /api/tickets` (QUE-9) on tap, and shows
  the issued `ticketNumber` on a result screen. The thermal print path
  (`BrowserPrintProvider` — hidden iframe + `window.print`, fire-and-forget so
  a print failure never blocks the result screen) was scaffolded under QUE-30;
  QUE-18 (Operational Interfaces, parent QUE-3, FR-KSK-02/03, NFR-PERF-03)
  closed the genuine **FR-KSK-03 receipt-schema gaps** QUE-30 left — a
  residual-gap polish ticket in the QUE-20 pattern (its AC#1 silent-print path
  and AC#3 latency test were already met by QUE-30; the real gap was AC#2
  template completeness). Two PRD-mandated receipt fields were missing:
  **Nama Toko** — `PrintPayload.storeName` existed but `CategorySelectPage`
  never populated it (the kiosk never fetched the store config); and **Jumlah
  Antrian Di Belakang** — `POST /api/tickets` returned no queue position.
  **`CreateTicketUseCase` now computes `waitingAhead`** (= same-category
  WAITING count − 1, the just-issued ticket being the newest) **inside the
  existing `txManager.runInTransaction` callback** (after `queue.save`) via a
  new `countWaitingByCategory(categoryId)` method on the `IQueueRepository`
  domain port (LSP — in-memory filters/`length`, Postgres `SELECT COUNT(*)::int
  …` via `withDbClient`, enlisting on the ambient tx client so the just-inserted
  row is visible and concurrent uncommitted inserts are excluded →
  deterministic). `waitingAhead` rides the `CreatedTicketDto` (additive — only
  the kiosk consumes the REST DTO; the WS `TICKET_CREATED` wire event is a
  separate domain event carrying only `{ ticketNumber, categoryId }`, so no WS
  consumer is affected). The receipt renders **"Anda antrian ke-{N} dari {N}"**
  where N = `waitingAhead + 1` — at issuance the visitor is always the newest
  waiting ticket, so position == total == N (decision confirmed with the PM;
  "jumlah antrian di belakang" is read as the waiting backlog the visitor
  faces). **Store-name fetch (FR-KSK-03 "Nama Toko"):** the kiosk adds
  `IKioskApi.getStoreName()` that reuses the existing `GET /api/system/config`
  read surface (returns `storeName` even pre-setup as `''` via
  `GetSystemConfigurationUseCase`) — no new REST endpoint/use case (DRY,
  matching the QUE-24 reuse precedent) — and the kiosk consumes only a minimal
  `{ storeName }` `StoreProfileSlice` type, never the full admin
  `SystemConfigurationDto` (ISP at the `IKioskApi` boundary; the mild ISP smell
  of touching the config endpoint is the accepted trade-off, arch-reviewer
  signed off). **Store-name fetch race (arch-reviewer finding, fixed):** the
  store-name fetch must be **`Promise.allSettled`-awaited alongside
  `listCategories` before the category buttons become interactive** — a
  fire-and-forget store-name fetch would let a fast tap (before the config
  fetch settled, e.g. a cold Nest bootstrap) print a headerless receipt. Both
  fetches are off the touch→print hot path (NFR-PERF-03 unaffected); a
  store-name *failure* never blocks the flow (`allSettled` — the receipt just
  omits the header line, which is optional in `PrintPayload`). **General rule:
  any receipt/print field sourced from a mount-time fetch must be resolved
  before the user-action that consumes it is enabled** — gate the action on
  the fetch, don't fire-and-forget a field that becomes user-visible. The
  kiosk owns only selection + issuance + printing — **no realtime/WS** (it is
  not a queue monitor) and no per-device binding.
- **`QueueEventDispatcher` import gotcha:** the dispatcher is NOT re-exported
  by the `src/application/queue` barrel — import it via the direct path
  `src/application/queue/queue-event-dispatcher` (as `realtime.module.ts` and
  `tickets-api.module.ts` do), not from the `application/queue` index.
- **Queue command lifecycle events (QUE-2):** the six command use cases
  (call-next/serve/complete/skip/recall/transfer) drain the aggregate's domain
  events by calling `await dispatcher.dispatch(ticket)` after `queue.save(ticket)`
  — without this the aggregate records `TICKET_CALLED` / `STATUS_UPDATED` /
  `TICKET_TRANSFERRED` but they never broadcast (FR-ENG-04). `dispatch(aggregate)`
  pulls events from an `AggregateRoot`; for **non-aggregate system events** (the
  daily reset rolls the whole sequence, not one ticket) use the sibling
  `await dispatcher.dispatchEvents(events: readonly DomainEvent[])`, which
  forwards a free-standing event list to the same `IQueueEventPublisher`.
  `DailyQueueResetEvent` (type `SYSTEM_RESET`) is the one such event in QUE-2's
  scope; it carries a sentinel `SYSTEM_AGGREGATE_ID = 'system'` (exported from
  `daily-queue-reset.event.ts`) since `DomainEvent` requires an `aggregateId`
  but no `SystemAggregate` exists. **Transfer emits two events:** because
  transfer ("Pindah Kategori") is a first-class transition, the aggregate
  records both a `STATUS_UPDATED` (CALLING → WAITING, actionLabel "Pindah
  Kategori") **and** a `TICKET_TRANSFERRED` — so a realtime test asserting a
  transfer must collect 2 messages, not 1 (the other single-transition commands
  emit exactly one `STATUS_UPDATED`).
- **Daily reset engine (QUE-2, FR-ENG-05):** `ResetDailyQueueUseCase`
  (`application/queue`) owns only `ISequenceRepository` + `QueueEventDispatcher`
  + an injected `clock`. It derives `date = toDateKey(clock())` internally (the
  date-key convention already lives in the application layer, same as
  `CreateTicketUseCase`), calls `sequences.resetDaily(date, resetTo)`, and
  emits `DailyQueueResetEvent(SYSTEM_AGGREGATE_ID, resetTo, date, clock())` via
  `dispatchEvents`. **Anti-corruption boundary:** the use case imports **no**
  Store-Config type — the interface-adapter layer (`SystemAdminController`,
  `DailyResetSchedulerService`) reads `DailyResetPolicy.resetTicketNumberTo`
  from `SystemConfiguration` and passes only the scalar `resetTo` into the
  command (dep-cruiser's `queue-no-store-config` rule is scoped to
  `src/domain/queue/`, so the application use case is unaffected, but the
  boundary is kept by intent, not by rule). The manual trigger is
  `POST /api/system/daily-reset`; the automatic trigger is
  `DailyResetSchedulerService` (`infrastructure/scheduler/`), an
  `@Injectable() OnModuleInit` that reads the config at boot and, if the policy
  is `AUTOMATIC_CRON` with a cron expression, arms a `@nestjs/schedule`
  programmatic `CronJob` (`new CronJob(cronExpr, cb)` +
  `schedulerRegistry.addCronJob(name, job); job.start();`) calling the use
  case. It is **boot-armed only** — it does not re-arm when the wizard later
  changes the config (a config change takes effect on next restart); re-arming
  pairs with the audit-trail work (NFR-SEC-02). `ScheduleModule.forRoot()` is
  imported in `AppModule` for the `SchedulerRegistry`.
- **PostgreSQL persistence (QUE-30):** `PersistenceModule.forRoot()` is a
  `DynamicModule` reading `QMS_PERSISTENCE` (default `in-memory`); the
  `postgres` profile binds the six repo tokens + `TRANSACTION_MANAGER` +
  `PG_CONNECTION` (a `pg.Pool` factory) to Postgres concretions and **excludes
  `DevSeedService`** (the wizard is the real seed; a dev seed would write a
  config and block the first-run redirect). The migration runner
  (`PostgresMigrationRunner`, `OnModuleInit`) is the only schema authority —
  no Prisma/TypeORM — applying `migrations/*.sql` idempotently into a
  `_migrations` table (SHA-256 checksums). **Build asset gotcha:** `tsc` does
  not copy `.sql` (or any non-TS asset) to `dist`, so the runner's
  `readdirSync(migrationsDir)` throws and is caught, making it **silently
  no-op** — no tables are created and the scheduler's `onModuleInit` query then
  fails with `42P01`. The `postbuild` script copies
  `src/infrastructure/persistence/postgres/migrations` into
  `dist/…/migrations`; any new non-TS runtime asset needs the same treatment.
  Gap-free sequence reservation (NFR-REL-02) is via the `ITransactionManager`
  port (domain): `PostgresTransactionManager` wraps `BEGIN`/`COMMIT` with an
  `AsyncLocalStorage` ambient client (confined to the postgres impl); the
  in-memory impl is a pure pass-through (`return work()`). Use cases that
  reserve-then-save (`CreateTicketUseCase`, `CallNextTicketUseCase`,
  `ResetDailyQueueUseCase`, `SaveSystemConfigurationUseCase`) take an
  **optional** `txManager` constructor param defaulting to
  `new NoOpTransactionManager()` so the unit specs' direct construction stays
  unbroken — the wired profile injects the real manager.
- **No-op default-param impls live in the domain, not infrastructure.**
  `NoOpTransactionManager` (and any sibling null-object default) is co-located
  with its port in `src/domain/shared/` because the application use cases
  reference it as a default constructor param (`new NoOpTransactionManager()`).
  Moving it to `src/infrastructure/` would make the application layer import
  infrastructure — a direct `application-no-infrastructure` dep-cruiser
  violation. The no-op is pure (no framework deps), so domain purity
  (NFR-MNT-01) holds. Do not "fix" this by relocating no-op defaults to
  infrastructure. (A `NoOpAuditLogRepository` was removed instead — it was dead
  code; audit repos are always wired via the `AUDIT_LOG_REPOSITORY` token, never
  defaulted in a use case.)
- **Relocate invariants when deleting a guardrail VO.** When a domain value
  object that enforced an invariant (e.g. the deleted `AudioQueueItem` required
  `counterId` to be a positive integer) is removed as dead code, its invariant
  must not silently vanish — surface it at the new enforcement site. Either
  re-guard at the replacement (a one-line `Number.isInteger(x) && x >= 1` throw)
  or document the precondition on the successor's signature (`@pre …`), naming
  the upstream guarantee that makes it safe. Deleting the VO without relocating
  the invariant lets bad input silently degrade (e.g. `buildCallFragments` would
  emit a `-.mp3` fragment for a negative id) instead of failing fast. The
  QUE-22 arch-reviewer surfaced exactly this: the guard died with the VO.
- **Acceptance suite (QUE-30):** the DoD-1..4 acceptance specs live in
  `services/core-api/test/acceptance/*.acceptance.spec.ts` (co-located in
  core-api — not a separate project — to reuse its jest config + ts-jest +
  `@core-api/*` aliases + direct `AppModule` imports). They run via
  `npm run test:acceptance` (`jest --testMatch '**/*.acceptance.spec.ts'`).
  **Jest `testMatch` vs `testPathIgnorePatterns`:** to keep acceptance specs out
  of the default `npm test` unit gate, use `testMatch` **negation** in
  `jest.config.js` (`['**/*.spec.ts', '!**/*.acceptance.spec.ts']`), NOT
  `testPathIgnorePatterns`. The CLI `--testMatch` overrides config `testMatch`
  (replacing it entirely) but does **not** override `testPathIgnorePatterns` —
  so an ignore-pattern entry excluding `*.acceptance.spec.ts` also excludes
  them from the `test:acceptance` run, yielding "No tests found" exit 1. DoD-4
  (`power-cut-recovery`) self-skips (`describe.skip`) when
  `QMS_ACCEPTANCE_DB_URL` is unset or `dist/main.js` is absent, so the gate
  stays green without a DB; CI sets the env var (and `scripts/run-acceptance.mjs`
  builds core-api first). It spawns `node dist/main.js` with
  `QMS_PERSISTENCE=postgres`, drives a ticket to `SERVING`, `SIGKILL`s it,
  respawns against the same DB, and asserts state + sequence recover exactly.
  Its `resetDb()` drops+recreates the `public` schema (not `TRUNCATE`, which
  fails on a cold DB with "relation does not exist") so the next boot re-applies
  all migrations from pristine.
  **Jest call-order assertions:** this repo's `@types/jest` does not expose
  `toHaveBeenCalledBefore` (TS2551 at compile). Assert mock call order with
  numeric `mock.invocationCallOrder[i]` comparisons instead — e.g.
  `expect(mockA.mock.invocationCallOrder[0]).toBeLessThan(mockB.mock.invocationCallOrder[0])`.
  **Jest spy accumulation:** `jest.spyOn(obj, method)` on the same prototype
  across tests returns the *same* spy — call counts accumulate and are NOT reset
  by re-spying in `beforeEach` (the jest config has no `restoreMocks`). A
  `expect(Logger.prototype.log).not.toHaveBeenCalled()` in test N sees test
  N-1's calls. Add `afterEach(() => jest.restoreAllMocks())` (restores the spied
  method, so the next `spyOn` mints a fresh spy) whenever a spec asserts call
  counts. The bootstrap-service spec dodges this only because it asserts
  `resolves.toBeUndefined()`, not call counts.
- **DB durability contract + startup recovery (QUE-28, NFR-REL-02):** QUE-30
  delivered the durability *mechanism* (tx manager, atomic sequence upsert, WAL
  reliance) but only *assumed* PG defaults — nothing enforced or verified them,
  so a misconfigured PG (`fsync=off`, `synchronous_commit=off`) would silently
  gap/lose ticket numbers. QUE-28 closes the *contract*: enforce
  `synchronous_commit=on` **per connection** via the pool `onConnect` **config
  option** in `createPgPool` (a `user`-context GUC — `SET` persists for the
  connection session, so commits wait for WAL flush regardless of the server
  default), and verify `fsync=on` at boot via `PostgresDurabilityProbe`
  (`@Injectable() OnModuleInit`, postgres profile only — `fsync` is
  `postmaster`-context, settable only at server restart, so it cannot be set
  per-session; the probe `SHOW fsync` and throws
  `DurabilityDegradedException` if not `on` — **fail-fast**, not warn; a queue
  that could lose numbers must not boot). The probe is the "startup recovery
  flow" alongside the migration runner; schema-independent (needs only the
  pool), so no `OnModuleInit` ordering constraint vs. `PostgresMigrationRunner`.
  No audit entry for boot recovery (NFR-SEC-02 scopes audit to manual reset /
  state-schema / routing); no startup state reconciliation/mutation (PRD says
  "recover exactly" — auto-rewinding CALLING→WAITING would violate it). The
  probe/exception live in `infrastructure/persistence/postgres/` (own boot I/O
  + `pg`); no domain port — a speculative `IDurabilityProbe` with no in-memory
  impl would be over-abstraction (consistent with `PostgresMigrationRunner`,
  which also injects the concrete `Pool` and throws a bare `Error`).
  **`onConnect` vs `pool.on('connect')` gotcha:** the `pool.on('connect',
  client)` **event** does NOT await promises/async setup, so a `SET` there
  races the client handout. Use the `onConnect` **config option** (`new Pool({
  onConnect: async (client) => { await client.query('SET …') } })`) — `pg-pool`
  wraps it in `_promiseTry(...).then()` (`index.js:288`) and awaits before
  handing the client out, destroying it on rejection. `@types/pg` types
  `onConnect` as `(client) => void` (sync), but an `async` fn is assignable
  (a `Promise<void>` return is allowed where `void` is expected) and is awaited
  at runtime — the typed signature understates the runtime. Verified via
  Context7 + the `pg-pool` source.
  **Acceptance-spec gating — direct-repo variant:** an acceptance spec that
  exercises repos/tx-manager directly via ts-jest (no `node dist/main.js` spawn)
  gates on `QMS_ACCEPTANCE_DB_URL` only — NOT `dist/main.js` (it needs no
  build). `sequence-durability.acceptance.spec.ts` proves the atomic-upsert
  contract: N parallel `nextTicketNumber` → exactly 1..N (no dupe/gap), and a
  `runInTransaction` that reserves then throws rolls the increment back so the
  next reservation reuses the number (gap-free on mid-tx failure). `beforeAll`
  drops+recreates `public` then runs `PostgresMigrationRunner.onModuleInit()` for
  a pristine schema (the runner's `__dirname/migrations` resolves to
  `src/…/migrations` under ts-jest, no build needed).
- **Daily analytics + local export (QUE-26, FR-ADM-03):** the Reporting read
  side is now wired end-to-end and the audit-trail read surface (left open by
  QUE-30) is folded in. New REST surface: `GET /api/reports/daily?date=`,
  `GET /api/reports/counters/:id?date=` (`ReportingController`, `api/reports`),
  `GET /api/audit/log` (`AuditLogController`, `api/audit`), each backed by a
  framework-free use case (`GetDailyReportUseCase`,
  `GetCounterPerformanceUseCase`, `ListAuditEntriesUseCase`) injected with a
  port (`REPORT_QUERY_PORT` Symbol token, `AUDIT_LOG_REPOSITORY`). **CQRS read
  side:** the report repos (`InMemoryReportQueryRepository`,
  `PostgresReportQueryRepository`) implement `IReportQueryPort` and compute
  metrics by scanning `tickets` `UNION ALL` `archived_tickets` within the local
  day window — raw SQL aggregation, no aggregate reconstitution. A read returns
  `null` when no tickets exist for the date; the controller maps that to an
  empty-shape DTO (total 0, avgs 0, empty `perCategory`) so the analytics
  dashboard has a clean zero state (never a 404). `ListAuditEntriesUseCase`
  lives in the **audit** bounded context (owns `AuditLogEntry`), mirroring the
  `ListCategoriesUseCase`-in-owning-context precedent.
  **Lifecycle timestamp columns (the analytics data model):** the
  `tickets`/`archived_tickets` schema and `QueueTicket` aggregate previously
  carried only `created_at`/`updated_at`, so wait-time (WAITING→CALLING) and
  service-time (SERVING→COMPLETED) were not computable. Migration
  `0003_ticket_lifecycle_timestamps.sql` adds `called_at`/`served_at`/
  `completed_at BIGINT` (idempotent `IF NOT EXISTS`) to both tables; the
  aggregate sets them on the named transitions — `markCalling` sets
  `calledAt`, `startServing` sets `servedAt`, `complete` sets `completedAt`;
  `recall` (SKIPPED→CALLING) re-sets `calledAt` (re-announce); `transferTo`
  clears all three to `null` (transfer re-enters the queue as a fresh ticket
  under the new category — new lifecycle). `reconstitute` gains 3 params →
  every call site (in-memory repo, Postgres repo, dev-seed, integration specs)
  must pass them. Postgres `AVG(...) FILTER (WHERE ...)` skips tickets that
  never reached the transition; `COALESCE(..., 0)` keeps the metric at 0 when no
  ticket reached it; pre-existing rows get NULL (acceptable — `FILTER` drops
  them).
  **Shared date util + anti-corruption:** the local-date helpers
  (`toDateKey`, `startOfLocalDay`, `startOfLocalDayFromKey`) live in
  `src/application/shared/date.ts` — owned once in the application layer so the
  date convention stays out of the pure domain (NFR-MNT-01) AND so a reporting
  or audit consumer does **not** reach across into the queue bounded context
  for a date utility (anti-corruption). Queue-context consumers re-export
  `toDateKey`/`startOfLocalDay` from `application/queue/create-ticket.use-case`
  for backward compat; new non-queue consumers
  (`reporting.controller.ts`, `queue-commands.controller.ts`,
  `dev-seed.service.ts`, both report repos, `reset-daily-queue.use-case.ts`)
  import from `application/shared/date` directly.
  **TS re-export gotcha:** `export { foo } from './x'` **re-exports but does
  NOT bind `foo` in the module body** — to *use* the helper inside the same
  file you need a separate `import { foo } from './x'` alongside the
  `export … from`. `create-ticket.use-case.ts` carries both: the `import` for
  its own `toDateKey(now)` call and the `export … from` for queue-context
  consumers. Forgetting the `import` compiles the re-export fine but TS2552s
  on the call site.
  **In-memory CQRS read-side seam:** the in-memory report repo needs live
  ticket-store access, but `allActive()` is a **reporting-only seam on the
  concrete `InMemoryQueueRepository`**, NOT a new method on the write-side
  `IQueueRepository` port (the write port stays free of list-all read methods
  — SRP/ISP). It is wired via `useFactory` injecting the `QUEUE_REPOSITORY`
  singleton (same instance the rest of the in-memory profile shares) plus
  `CATEGORY_REPOSITORY`, so it reads live data. The Postgres read side needs
  no such seam (it queries the tables directly via `withDbClient`).
  **Acceptance-test timing gotcha:** in-process supertest calls are
  sub-millisecond, so `completedAt === servedAt` and the service-time delta
  rounds to 0. The DoD-5 `analytics-export` acceptance spec inserts real
  `setTimeout` sleeps (`await sleep(2)`, jest real timers) between lifecycle
  steps (create → call → serve → complete) for deterministic ≥1ms deltas so
  `avgWaitTimeMs`/`avgServiceTimeMs` are non-zero. Use the same pattern for any
  acceptance spec asserting a positive time delta.
  **SheetJS offline bundling (NFR-REL-01):** the admin-service xlsx export
  vendors `xlsx@0.18.5` (SheetJS), generated client-side via
  `XLSX.writeFile(wb, 'qms-report-<date>.xlsx')` (Blob download, fully
  offline). SheetJS bundles OOXML/ODF **XML namespace identifier URLs**
  (`http://schemas.openxmlformats.org/…`, `http://purl.org/…`,
  `http://purl.oclc.org/…`, `http://openoffice.org/…`,
  `http://docs.oasis-open.org/…`, `http://schemas.microsoft.com/…`,
  `http://sheetjs.com`, `http://macVmlSchemaUri`) — these are XML namespace
  URIs / metadata written into the `.xlsx`, **never fetched at runtime** (same
  class as `w3.org`). They surface in a `grep https?:// dist/assets` and must
  be whitelisted in the `offline-assets.acceptance.spec.ts` `ALLOWED_HOSTS`
  with a rationale comment, not treated as a runtime network call.
- **Transaction-log cleanup + manual reset (QUE-25, FR-ADM-02 / NFR-SEC-02,
  parent QUE-6, Hardening):** the eviction step that keeps `archived_tickets`
  from growing unbounded as each daily reset relocates prior-day tickets into
  it. **`purgeArchivedBefore(thresholdMs)`** is added to the existing
  `ITicketArchivePort` (ISP — the cleanup use case needs only purge, not the
  full `IQueueRepository` write surface; the concrete queue repos already
  implement both ports and `TICKET_ARCHIVE_PORT` is bound via the existing
  `useExisting: QUEUE_REPOSITORY` alias, so no new binding). It purges
  `archived_tickets` ONLY — **`audit_log` is never touched** (the audit trail
  is the compliance record, NFR-SEC-02, preserved indefinitely). **Domain
  guardrail floor:** `MIN_RETENTION_DAYS` (7) lives in the **application layer**
  (`cleanup-transaction-log.use-case.ts`) — a use-case-level business
  guardrail, not a `SystemConfiguration` field — and an under-floor /
  non-integer `retentionDays` throws `InvalidArgumentException` **before** the
  tx opens so an illegal cleanup burns no rows (NFR-REL-02 pattern). **Atomicity
  (NFR-REL-02):** the purge + the `TRANSACTION_LOG_CLEANUP` audit append run
  inside one `ITransactionManager.runInTransaction`; repos enlist on the ambient
  client (`withDbClient`). The cleanup is **actor-gated** like `MANUAL_RESET`:
  the audit entry is written only when `actor` is present (there is no
  automatic/cron path). `CleanupTransactionLogUseCase` reuses `startOfLocalDay`
  from `application/shared/date` (QUE-26) — **no queue-local date copy**.
  `POST /api/system/cleanup-transaction-log` on `SystemAdminController` threads
  only scalars (`retentionDays`, `actor`); wired in `QueueOperationsModule` via
  a factory composing `RecordAuditEntryUseCase` inline (canonical pattern). The
  manual daily-reset **button** is the admin UI surface for the pre-existing
  `POST /api/system/daily-reset` (QUE-2/QUE-16); the cleanup form + reset button
  both use synchronous `useRef` double-tap guards + `window.confirm`.
  **`InvalidArgumentException` is a domain error for use-case-level business
  guardrails** (`domain/shared/errors.ts`), distinct from
  `InvalidValueObjectException` (a malformed value object) and
  `InvalidStateTransitionException` (a forbidden state move): the value is
  well-formed, just not permitted by a use-case rule. The exception carries no
  business rule itself (the floor value lives in the application layer); it is
  transport-agnostic, mapped to 400 by `DomainExceptionFilter`. This mirrors
  `SystemNotConfiguredException` (also a domain error thrown from use cases /
  controllers, not aggregates). **Audit READ surface is deliberately NOT
  duplicated here** — QUE-26 (PR #17, merged) already ships
  `ListAuditEntriesUseCase` + `GET /api/audit/log` + the `AnalyticsPage` audit
  viewer + `application/shared/date`; QUE-25 reuses those and adds **no** read
  surface (only the WRITE via `RecordAuditEntryUseCase` inside the tx). When a
  sibling PR merges first and absorbs an in-flight branch's planned scope,
  rebase onto the new base and drop the duplicate, deferring to the merged
  canonical surface (don't ship a second, conflicting implementation of the
  same surface — e.g. a newest-first/filtered `GET /api/audit` colliding with
  QUE-26's oldest-first `GET /api/audit/log`). **`actor: 'admin'` is a
  hardcoded string literal** on both the reset + cleanup endpoints (pre-existing
  pattern from QUE-2) — the audit trail cannot distinguish which manager
  performed a destructive op; out of scope until an auth/identity layer lands
  (could later thread a gateway-injected `X-Manager-Id` header). **Landed in
  QUE-32** (Hardening, was blockedBy QUE-25): scheduler re-arm on daily-reset-
  policy change, backend cron-format enforcement, and a `DAILY_RESET_POLICY_CHANGE`
  audit action.
- **Scheduler re-arm + cron enforcement + policy-change audit (QUE-32,
  FR-ADM-01 / NFR-SEC-02, parent QUE-6, Hardening):** the daily-reset scheduler
  is no longer boot-armed-only. `DailyResetSchedulerService` implements a new
  non-repository domain port `IDailyResetSchedulerPort` (`domain/store-config/
  scheduler.port.ts`, `DAILY_RESET_SCHEDULER` Symbol token — same shape as the
  `ITransitionPolicyResolver` precedent: a non-repository port in the domain,
  implemented in infrastructure). Its single method `reArm()` re-reads the
  persisted `SystemConfiguration` and **idempotently reconciles** the armed cron:
  arm / disarm (MANUAL or unconfigured) / no-op (desired cron already matches the
  tracked `armedCron` field, so a categories-only save does not churn the running
  cron). `onModuleInit` now just calls `reArm()`. `SaveSystemConfigurationUseCase`
  gets an optional `scheduler: IDailyResetSchedulerPort | null = null` constructor
  param (the `recordAudit: null` precedent — null = skip, no no-op class needed,
  distinct from `NoOpTransactionManager` which is a called-every-time default) and
  calls `await this.scheduler.reArm()` **post-commit** (after `runInTransaction`
  resolves), gated on the policy actually having changed (or the initial setup) —
  so a rolled-back save never re-arms to an un-persisted policy (NFR-REL-02, the
  same dispatch-after-commit pattern as `SYSTEM_RESET`). Wiring: `SchedulerModule`
  binds `{ provide: DAILY_RESET_SCHEDULER, useExisting: DailyResetSchedulerService }`
  + exports it; `SystemConfigApiModule` imports `SchedulerModule` and injects the
  token into the `SaveSystemConfigurationUseCase` factory (6th arg). **No circular
  dep:** `SystemConfigApiModule → SchedulerModule → QueueOperationsModule →
  SystemConfigModule`-the-resolver; none import `SystemConfigApiModule`. The
  concrete `armedCronExpression` getter stays on the service (not the port) as an
  integration-test observability seam — not leaked to the use case (ISP).
  **Construct-before-delete robustness (NFR-REL-02):** `reArm()` builds the new
  `CronJob` **before** deleting the old registered one — the `cron` library parses
  + validates the expression in the constructor (the realistic throw site), so a
  throw leaves the previously-armed cron intact instead of leaving the store with
  no automatic daily reset while the DB has already committed the new policy. The
  VO's `isValidCronExpression` guard makes that throw near-impossible, but the
  ordering keeps `reArm` self-safe regardless. Apply the same
  construct-validate-before-destroy pattern to any future re-arm/replace of a
  long-lived resource whose destruction is not auto-recovered.
  **Backend cron-format enforcement:** `DailyResetPolicy.of` now validates the
  5-field cron **format** (not just non-emptiness) for `AUTOMATIC_CRON` via a pure
  domain helper `isValidCronExpression` (`domain/store-config/value-objects/
  cron-expression.ts`) that **mirrors** `admin-service/src/lib/cron.ts` exactly
  (5 fields; ranges menit 0-59 / jam 0-23 / tanggal 1-31 / bulan 1-12 / hari 0-7
  with 0 and 7 = Sunday; `*`, comma lists, ranges `a-b`, steps `*/n` / `a-b/n` /
  `a/n`; no named months/days, no `@macros` / `L` / `W` / `#`). Localized
  duplication across the backend-domain / frontend-bundle boundary is intentional
  (separate build trees; a shared package for one pure function would
  cross-couple them) — the two grammars MUST stay in lock-step; a divergence is a
  bug. **Exception choice:** a malformed cron throws `InvalidValueObjectException`
  (code `INVALID_VALUE_OBJECT`, → 400), NOT `InvalidArgumentException` — a
  malformed cron is a malformed value object (the VO's existing non-empty check
  already throws `InvalidValueObjectException`), and `InvalidArgumentException`
  is reserved for use-case-level business guardrails where the value is
  well-formed but not permitted (e.g. the QUE-25 retention floor). An AC that
  loosely says `INVALID_ARGUMENT` for a VO-format rejection is satisfied at the
  HTTP level (400); keep one VO's construction failures uniform under
  `InvalidValueObjectException`. **MANUAL mode may carry a stale cron unchecked**
  (it is never armed), so the VO does not 400 on a stale value when a manager
  switches mode — the admin/wizard client nulls the cron field on MANUAL
  (`finalize`, QUE-16) so this only matters for a direct API call.
  **`DAILY_RESET_POLICY_CHANGE` audit action** (new `AuditAction` enum value) is
  recorded by `SaveSystemConfigurationUseCase` inside the same tx as
  `STATE_SCHEMA_CHANGE` / `ROUTING_CHANGE`, but **change-gated** (unlike those
  two, which are recorded on every save): only when `!oldPolicy.equals(newPolicy)`
  (`ValueObject.equals` structural deep-equal over the four policy props), with
  before/after snapshots (`dailyResetPolicySnapshot` helper, mirroring the
  `categorySnapshot` / `routingSnapshot` pattern). On initial setup `oldPolicy`
  is null → recorded with `before: null`. The gate is **structural, not
  operational** equality — a MANUAL→MANUAL save whose stored cron string differs
  would count as a change even though no cron is armed either way; acceptable
  (the snapshot accurately reflects the stored VO, and the client nulls cron on
  MANUAL so it only arises from a direct API call).
- **Compose boot-order (QUE-27):** the `gateway` must `depends_on
  core-api-service` with `condition: service_healthy`, and `core-api-service`
  must carry a healthcheck (`/api/health` via `wget`, which ships in
  `node:20-alpine` — no curl). Without it, nginx starts as soon as the
  container process does and 502s through the ~1–2 s Nest bootstrap +
  migration-runner window. `/api/health` (`HealthController`) answers
  pre-wizard, so it is a true liveness probe, not just a process probe. The
  four static-PWA frontends stay on `service_started` (their nginx is ready
  instantly — no healthcheck needed).
- **Topology smoke test (QUE-27):** `npm run compose:verify`
  (`scripts/verify-topology.mjs`) is the gate proving the compose topology
  serves every PRD route through the gateway. Tier 1 (no Docker daemon)
  validates `docker compose config` + asserts all seven PRD services are
  declared; tier 2 (when a daemon is up) boots the stack and asserts
  `/api/health` 200, the `/` + `/wizard` 301 redirects, and the four PWA
  routes 200 via the gateway, then `docker compose down -v`. It is
  intentionally NOT part of `scripts/run-verify.mjs` so the per-service
  unit/build gate gains no Docker dependency. **Gateway redirect assertion
  gotcha:** nginx emits an ABSOLUTE `Location` (e.g. `http://localhost/admin/`)
  for a relative `return 301 /admin/` (it resolves against the `Host` header),
  so route assertions must match `Location` by suffix (`endsWith('/admin/')`),
  not strict equality — and use Node's `http` module, not `fetch`
  (`redirect: 'manual'` returns an opaqueredirect response with status 0 and
  filtered headers, hiding the 301).
- **Gateway first-run guard (QUE-13, FR-WZD-01):** while
  `isInitialSetupCompleted == false` the gateway must redirect **all** HTTP
  access to `/wizard` — the PRD is strict here ("semua akses HTTP"), and PRD wins
  over any client-side-only approach. nginx can't read the DB, so the guard is
  an `auth_request` subrequest to core-api's `GET /api/system/setup-status`
  (the `auth_request` module ships in `nginx:alpine` — no Lua needed). That
  probe maps the boolean to the HTTP status itself: `200` when setup is
  complete, `403 { code: 'SETUP_REQUIRED' }` when not. It **must never throw**
  on a clean store — `auth_request` treats 2xx as allow, 401/403 as deny, but
  any other status (a 409 `SystemNotConfiguredException`, a 500) is a hard
  error, not a deny, so the deny has to be a real 403. That mapping is an
  interface-adapter concern done with `HttpException` (not `@Res`, to stay
  platform-agnostic at the Nest layer), kept out of the pure use case; the 403
  uses a **distinct** `SETUP_REQUIRED` code so the gateway deny isn't confused
  with the 409 `SYSTEM_NOT_CONFIGURED` the queue command surface throws. The
  `auth_request` is scoped to the **document request only** (`location =
  /kiosk/` etc.) — an unconfigured client is redirected before its HTML loads
  so it never fetches assets, and once setup is complete assets stream
  unguarded (no per-asset subrequest in the steady state). **Exempt** from the
  guard (no `auth_request`): `/api/` (the wizard must PUT config + read
  setup-status), `/admin/` (wizard SPA host — must load to perform setup),
  `/wizard`, `/ws`, and `/`. The `/admin/` client-side `SetupGuard` stays as
  progressive enhancement; the gateway guard covers the operational routes
  the SPA guard can't reach. The guard's end-to-end proof is tier-2 of
  `scripts/verify-topology.mjs` (pre-setup `/kiosk/ /tv/ /caller/` → 302
  `/admin/wizard`, then `PUT /api/system/config`, then 200). **`nginx -t`
  standalone gotcha:** nginx resolves `upstream` hostnames (`core-api-service`)
  at config-load time against the container network's DNS; running `nginx -t`
  outside the compose network fails with "host not found in upstream" even
  when the config is valid. Validate syntax by `sed`-replacing the upstream
  hostnames with `127.0.0.1:3000` into a temp conf and running `docker run --rm
  -v /tmp/nginx.conf:/etc/nginx/nginx.conf:ro nginx:alpine nginx -t` — that
  exercises the real `auth_request` module load without needing the compose
  network. `BootstrapService` (`infrastructure/bootstrap/`, `OnModuleInit`)
  formalizes AC#2 ("config re-readable at startup") — an eager, observable
  startup read of `SystemConfiguration` that logs the outcome across profiles;
  it does not cache or publish (per-execution policy resolution + the
  setup-status probe still read the repo directly).
- Frontends are React-family; `caller-service` is a PWA. Keep them
  offline-capable (bundle + precache all assets — vite-plugin-pwa; relative
  `/api` + `/ws` URLs so they're same-origin behind NGINX with no per-service
  config, proxied to `core-api:3000` by Vite in dev).
- **Frontend service conventions** (established by `caller-service`, QUE-19):
  - **Vite + vitest config typing:** `vite.config.ts` imports `defineConfig`
    from `vitest/config` (not `vite`) whenever it carries a `test` field —
    otherwise `tsc -b` fails with `'test' does not exist in type
    'UserConfigExport'`.
  - **jsdom has no global `WebSocket`.** Realtime clients take an injectable
    `WebSocketCtor` and avoid referencing global `WebSocket.OPEN` /
    `WebSocket.CONNECTING` (use the numeric readyState constants inline) so a
    test-injected fake transport works. The provider/test seam is the
    *transport constructor*, not a pre-built socket.
  - **Providers that own a long-lived resource** (WebSocket, EventSource,
    polling timer) accept construction **options**, never a pre-built instance.
    The provider constructs the resource and wires its own handlers; an
    injected instance would carry pre-bound handlers that never reach the
    store. Tests inject options (e.g. `{ WebSocketCtor: FakeWebSocket }`) and
    drive the fake transport.
  - **React 18 batches dispatches** from non-React async callbacks (e.g. a WS
    `onopen`/`onmessage` handler). In RTL tests, assert the resulting DOM with
    `await screen.findByText(...)`, not the synchronous `screen.getByText(...)`
    which reads the DOM before the batched re-render flushes.
  - **`tsc -b` composite artifacts are build output, not source.**
    `tsconfig.node.json` (`composite: true`, includes `vite.config.ts`) emits
    `vite.config.js`, `vite.config.d.ts`, and `*.tsbuildinfo` on every build.
    Add a per-service `.gitignore` excluding them so the tree doesn't churn on
    each build — `caller-service` predates this rule and tracks them; new
    frontends (`kiosk-service` onward) gitignore them.
  - **Touch-surface mutations need a synchronous double-tap guard — kiosk AND
    caller.** `disabled` only takes effect after a re-render, so two clicks
    landing in the same tick both pass a state-based guard. This applies to the
    public kiosk ("issue ticket") **and** the staff-facing caller touch PWA
    (the caller panel runs on a touchscreen at the counter; its `ActionControls`
    `run()` uses the same `useRef<boolean>` in-flight guard). Flip the ref
    *before* the first `await` and reset it in `finally`; keep `disabled` as the
    visible affordance. Two taps must produce exactly one mutation (asserted in
    the kiosk + caller tests). A state-only `pending` guard is NOT enough — it
    updates after a re-render, so two same-tick taps both see `pending === null`
    and both fire (the trap the arch-reviewer flagged on QUE-20's first pass).
  - **Caller WS projections recover missing fields from local state, never
    blank.** The wire event payloads are lossy by design: `TICKET_CALLED`
    carries only `{ ticketNumber, counterId }` (no `categoryId`), and
    `STATUS_UPDATED` carries only `{ from, to }` (no `ticketNumber`/`counterId`
    — see the QUE-21 recall-restore trap). When the projection needs a field the
    payload omits, recover it from the existing local entry (the prior
    `state.waiting` record for `TICKET_CALLED`) rather than blanking it to `''`/`null`.
    The `TICKET_CALLED` `categoryId` preservation (QUE-20) is the instance: a
    freshly-called ticket had `categoryId === ''` so the transfer chooser's
    "exclude current category" excluded nothing; reusing the waiting entry's
    `categoryId` makes the chooser correct on the live call-next path. Fallback
    to `''` only if the prior entry is genuinely absent (defensive).
  - **Step-form RTL tests: re-query DOM nodes after step re-entry, and use
    `fireEvent.change` for controlled numeric inputs bound to derived state.**
    The wizard renders each step with `{step === N && <section>…}`, so navigating
    away (next) **unmounts** the step and going back (Kembali) **recreates** the
    nodes — a `const input = screen.getBy…` captured on the first visit is a
    detached node after a round-trip; `fireEvent.change` / `userEvent.type` on it
    no-ops (state never updates). Re-query via `screen.getBy…` after the
    `findByTestId('step-N')` that confirms re-entry. Separately, a controlled
    numeric input whose `value` is derived from state (e.g. `value={form.routingRules.length}`) cannot be set with `userEvent.clear` + `type`:
    `clear` fires `onChange('')` → clamps back to the current length, so the
    field snaps back and `type` appends to the stale value. Use
    `fireEvent.change(input, { target: { value: '3' } })` to set it cleanly.
  - **PWA `base`/`start_url`/`scope` must match the NGINX route** (e.g.
    `/kiosk/`, `/caller/`) — otherwise an installed PWA's `start_url` resolves to
    the gateway root, not the service, breaking offline launch. Set them when
    scaffolding a new frontend. (All four existing frontends — admin, kiosk, tv,
    caller — are already aligned to their `/svc/` prefix; QUE-27.)
  - **TV audio queue (QUE-22, FR-TV-02):** announcement-level serialization is a
    **decorator** (`QueuedAudioProvider` in `tv-display-service/src/audio/`)
    over the fragment sequencer (`SequencerAudioProvider`), not a god-class.
    SRP split: the inner serializes fragments *within* one announcement; the
    decorator serializes whole announcements *between* calls. The decorator
    implements the same `AudioProvider` (`playSequence`/`stop`) interface, so
    it is a drop-in — the store keeps depending on the abstraction (`App.tsx`
    wires the concrete `QueuedAudioProvider(SequencerAudioProvider)`). **The
    drain single-flight guard is load-bearing:** in `drain()`,
    `if (this.running) return; this.running = true;` must run synchronously
    *before the first `await`* so a second `playSequence` arriving while the
    inner is mid-fragment only enqueues — never starts a second concurrent
    drain (which would reintroduce overlap). Do not reorder those two lines or
    push the assignment behind an `await`. The queue is **FIFO, not
    interrupt-on-new-call** — a half-announced ticket number is worse UX than a
    brief lag. `buildCallFragments` decomposes **both** the ticket number and
    the counter id digit-by-digit so every fragment maps to an existing
    `/tv/audio/<digit>.mp3` (NFR-REL-01 — there is no `10.mp3`); a single
    `'10'` counter fragment would be silently dropped by the sequencer's
    error-skip. There is **no `domain/notification` bounded context in
    core-api** — audio is a pure client concern (the backend never plays
    sound); the earlier domain `AudioProvider`/`AudioQueueItem` stub was
    removed as dead code (zero importers, no use case).
  - **TV board history projection (QUE-21, FR-TV-01):** the `tv-store`
    `history` ("Riwayat Panggilan", up to 5) retains a ticket when it
    **concludes**, not merely when the next call displaces it. `projectEvent`'s
    `STATUS_UPDATED` case pushes the outgoing `nowServing` into `history` on a
    `COMPLETED` transition (then nulls it) — without this the common
    single-counter flow (call → serve → complete → call next) left history
    empty: the completed ticket was null'd and the next `TICKET_CALLED` found
    `nowServing` already null and pushed nothing. `SKIPPED` (recallable via
    "Panggil Ulang") and `WAITING` (transfer, re-enters the queue) are
    deliberately **not** retained — neither is a concluded call. **Known
    deferred gap:** recalling a skipped ticket (`STATUS_UPDATED`
    `SKIPPED → CALLING`) does **not** restore `nowServing`, because the wire
    `STATUS_UPDATED` payload carries only `{from, to}` (no `ticketNumber` /
    `counterId`), so the board cannot reconstruct the entry from the event
    alone. Do not "complete" history by pushing `SKIPPED` into it without also
    implementing recall-restore (pull the ticket back out of history by
    `aggregateId`), or a recalled ticket would appear in history but not on the
    now-serving board. No double-push: the `aggregateId` guard skips a
    `STATUS_UPDATED` for a ticket no longer `nowServing`, and a `TICKET_CALLED`
    after a `COMPLETED` finds `nowServing` null so pushes nothing.
- When adding a feature, map it to the relevant FR-* / NFR-* requirement in the
  PRD and the bounded context it belongs to. Preserve the interface boundaries
  (e.g. don't leak admin DTOs into `ICallerApi`).
- Tests: include `InMemoryQueueRepository`-based unit tests for use cases;
  integration tests must run without internet.

## Linear integration

Create/triage issues against the **Queue System** team (key `QUE`), project
**Enterprise Offline Queue Management System (QMS)**. Use the `product-manager`
agent for ticket lifecycle and the `linear-*` skills (`linear-create-issue`,
`linear-bug`, `linear-techdebt`) for new work.

- **API gotcha:** `list_projects` with multiple `include*` flags raises a
  "query too complex" 400. Instead, `list_projects` filtered by `team` +
  `query:"QMS"`, then `get_project` (by name) for the full description.
- **Ticket lifecycle convention:** move a ticket to **In Progress** once its
  plan is approved (before coding begins), and to **In Review** when its PR is
  opened. Attach the PR link to the Linear issue.
- **Branch naming:** `<type>/que-<n>-<slug>` where `<type>` ∈
  `feat`/`fix`/`refactor`/`chore` (e.g.
  `feat/que-12-local-websocket-event-broadcaster`). This overrides Linear's
  suggested `franssiswanto/que-…` branch name.