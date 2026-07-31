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
- **OCP** — `AudioProvider` is an interface; add providers (MP3 files, offline
  TTS) without touching use cases.
- **LSP** — `IQueueRepository` is implemented by `PostgreSQLQueueRepository` and
  `InMemoryQueueRepository` (tests); they must be interchangeable.
- **ISP** — `caller-service` consumes only `ICallerApi`; never leak admin/reporting DTOs to it.
- **DIP** — Use cases & domain depend on interfaces, not the ORM/DB directly.

## Domain model (DDD bounded contexts)

Four bounded contexts:

- **Queue** — `QueueTicket` aggregate (`TicketId` UUID, `ticketNumber` e.g.
  "A-001", `categoryId`, `currentStatus`, `counterId`, timestamps). Events:
  `TicketCreatedEvent`, `TicketStatusChangedEvent`, `DailyQueueResetEvent`.
- **Store Config** — `SystemConfiguration` aggregate
  (`isInitialSetupCompleted`, `storeName`; VOs `StateSchema`,
  `StateTransitionRule`, `DailyResetPolicy`) and `CounterRoutingRule`
  aggregate (`counterId`, `assignedCategoryIds`, `priorityPolicy` ∈
  {`FIFO_GLOBAL`, `CATEGORY_PRIORITY`}).
- **Notification** — `Audio Queue Engine`, `Display Event Sync`.
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
  `QueueCommandsApiModule` exposes the caller command REST surface. Other
  services (`tv-display`, `admin`) are not yet scaffolded.
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
  structural types instead (the WS gateway does the latter).
- **NestJS DI for interface ports:** `interface` ports (`IQueueRepository`,
  `IQueueEventPublisher`, …) are erased at runtime, so NestJS can't resolve
  them by type metadata. Inject each via a co-located Symbol token + `@Inject`
  (see `QUEUE_EVENT_PUBLISHER` in `event-publisher.port.ts`), and bind it in the
  module with `{ provide: <token>, useClass: <impl> }`.
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
- **Kiosk ticket flow (QUE-17):** the kiosk takes a category via
  `GET /api/categories`, then `POST /api/tickets` (QUE-9) on tap, and shows the
  issued `ticketNumber` on a result screen. Printing is QUE-18 (not wired here).
  The kiosk owns only selection + issuance — **no realtime/WS** (it is not a
  queue monitor) and no per-device binding.
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
  - **Public-touchscreen mutations need a synchronous double-tap guard.**
    `disabled` only takes effect after a re-render, so two clicks landing in the
    same tick both pass a state-based guard. For a kiosk "issue ticket" tap,
    flip a `useRef<boolean>` in-flight flag *before* the first `await` and reset
    it in `finally`; keep `disabled` as the visible affordance. Two taps must
    produce exactly one mutation (asserted in the kiosk tests).
  - **PWA `base`/`start_url`/`scope` must match the NGINX route** (e.g.
    `/kiosk/`, `/caller/`) — otherwise an installed PWA's `start_url` resolves to
    the gateway root, not the service, breaking offline launch. Set them when
    scaffolding a new frontend. (Latent gap: `caller-service` and `kiosk-service`
    currently use `/`; align existing services during the Hardening milestone.)
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