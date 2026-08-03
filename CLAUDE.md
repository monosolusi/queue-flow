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

## Commands

All commands run from the repo root unless noted. Per-service scripts run from
that service's directory (e.g. `services/core-api`).

| Task | Command |
|---|---|
| Bring up the whole stack | `docker compose up -d` (root) |
| Per-service unit + build gate | `npm run verify` (root, runs `scripts/run-verify.mjs`) |
| core-api arch check | `npm run arch:check` (in `services/core-api`) — dep-cruiser, **must stay clean** |
| core-api unit tests | `npm test` (in `services/core-api`) |
| core-api build | `npm run build` (in `services/core-api`) — `postbuild` copies `.sql` migrations |
| core-api acceptance suite | `npm run test:acceptance` (in `services/core-api`) — `jest --testMatch '**/*.acceptance.spec.ts'` |
| Acceptance runner (builds core-api first) | `npm run acceptance` (root, `scripts/run-acceptance.mjs`) |
| Topology smoke test (Docker) | `npm run compose:verify` (root, `scripts/verify-topology.mjs`) |
| Frontend dev / build / test | `npm run dev` / `npm run build` / `npm test` (in `services/<svc>`) — vitest |
| Compose up/down | `npm run compose:up` / `npm run compose:down` (root) |

Postgres profile (DoD-4): `QMS_PERSISTENCE=postgres` activates the Postgres repo
bindings (default is `in-memory`). Acceptance specs that need a real DB gate on
`QMS_ACCEPTANCE_DB_URL` (and some on `dist/main.js`).

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
- **Single-host deployment readiness (NFR-MNT-02).** The whole stack — every
  service, the DB, and the gateway — comes up with one command,
  `docker compose up -d`. Any new service must be declared in
  `docker-compose.yml` (with `restart: always` per NFR-REL-03) and routed by the
  `gateway` so it is reachable through the single LAN entry point; do not add a
  service that requires a separate bring-up step.

## Project status / milestones

Milestones (Linear), in order:

1. **Foundation & Architecture** — deployment, persistence, offline single-host setup.
2. **Core Queue Workflow** — queue engine, state transition, routing, realtime events, daily reset.
3. **Operational Interfaces** — kiosk, caller panel, TV display, audio engine, admin operations.
4. **Hardening & Acceptance** — audit trail, analytics, resilience tests, offline E2E verification.

Definition of Done (PRD §8): static analysis proves the Domain layer is
dependency-free; first-run wizard redirects a clean browser to `/wizard` and
completes the 4 steps; full flow (kiosk ticket → thermal print → caller → TV
audio/display) works with WAN cable unplugged; power-cut recovery test passes
with no duplicate/lost ticket numbers.

### Current state

- **Git:** remote `monosolusi/queue-flow`, default branch `main`. Branch
  naming: `<type>/que-<n>-<slug>` (`feat`/`fix`/`refactor`/`chore`, e.g.
  `feat/que-12-local-websocket-event-broadcaster`) — overrides Linear's
  suggested `franssiswanto/que-…` name.
- **core-api (NestJS + TypeScript):** Clean Architecture layers in place;
  Domain layer pure (dep-cruiser-enforced, `npm run arch:check`). Three bounded
  contexts: Queue, Store Config, Reporting (the `Notification` stub was
  removed — audio is a pure client concern). All queue command use cases,
  ticket generation (`POST /api/tickets`), the daily-reset engine, PostgreSQL
  persistence behind domain ports + `ITransactionManager`, the audit context,
  and the system-config REST surface are landed. In-memory profile is the
  dev/test default; `QMS_PERSISTENCE=postgres` activates Postgres.
- **Frontends (all Vite + React + TS PWAs):** `caller-service` (`/caller`),
  `kiosk-service` (`/kiosk`), `tv-display-service` (`/tv`), `admin-service`
  (`/admin`, `/wizard`). All four PWAs' `base`/`start_url`/`scope` are aligned
  to their `/svc/` prefix. Shared design-token system + a11y/interaction
  baseline via generated vendored copies (QUE-37).
- **Deployment:** `docker-compose.yml` + per-service Dockerfiles + nginx
  `gateway` with first-run `auth_request` guard. `gateway` `depends_on
  core-api-service` with `condition: service_healthy`.
- **Acceptance:** DoD-1..5 specs in `services/core-api/test/acceptance/`, run
  via `npm run test:acceptance` (or root `npm run acceptance`). DoD-4
  power-cut recovery and durability specs gate on `QMS_ACCEPTANCE_DB_URL`.
- **PRD language:** the Linear PRD is written in **Bahasa Indonesia** with
  English technical terms. UI `action_label` values ("Panggil Berikutnya",
  "Lewati / Absen", "Selesai Layan") are Indonesian — match them verbatim
  when wiring the state machine.

Per-ticket history (PR numbers, arch-review verdicts, "In Review" status) is
not kept here — see git history and the Linear project for that.

## Working in this repo

The repo is a monorepo; each service lives in its own directory (e.g.
`services/core-api/`, `services/kiosk/`). The monorepo is TypeScript
throughout (frontends are React-family TS). Backend stack for
`core-api-service` is **NestJS + TypeScript** (decided QUE-8; the PRD left
Node.js/NestJS vs Go open). The Domain layer (`src/domain/**`) is pure
TypeScript with zero framework/ORM/IO imports; the Clean Architecture layering
rules apply identically.

`core-api` internal layout: `src/domain` (pure, framework-free entities/VOs/
aggregates/events/ports), `src/application` (use cases), `src/infrastructure`
(repo implementations — `persistence/in-memory/` default, Postgres under
`QMS_PERSISTENCE=postgres`), `src/interface-adapters` (REST controllers / WS
gateways). Repository interfaces are **ports defined in the domain layer**;
concrete implementations live in infrastructure. Aggregate IDs are branded
types (e.g. `TicketId`) to prevent cross-aggregate ID confusion; types shared
across bounded contexts (e.g. `PriorityPolicy`) live in `src/domain/shared/`.

### Architecture enforcement & use-case conventions

- **Domain purity is enforced by dependency-cruiser** — `npm run arch:check`
  (from `services/core-api`). It forbids `src/domain/**` from importing any
  ORM/HTTP/IO library (NFR-MNT-01), forbids the Queue bounded context from
  importing Store Config internals (anti-corruption), and forbids
  `src/application/**` from importing `src/infrastructure/**`
  (`application-no-infrastructure`) so use cases depend on domain ports, never
  concrete repos (DIP).
- **Verify a forbidden rule actually catches.** A rule that "passes" while a
  known framework import sits in `src/` is a red flag — temporarily add the bad
  import before trusting it. Two dep-cruiser gotchas:
  - **`not-to-unresolvable`:** `arch:check` flags a bare import when the
    package's `package.json` `exports` field has no `default` condition (e.g.
    `ws`). Either add `conditionNames` to `enhancedResolveOptions` in
    `.dependency-cruiser.cjs`, or don't import the package directly in `src/`
    — depend on `@nestjs/*` wrappers or local structural types instead (the WS
    gateway does the latter).
  - **`to.path` regex anchor:** dep-cruiser resolves a bare specifier to
    `node_modules/<pkg>/…`, so a `forbidden.to.path` rule anchored
    `^(@nestjs/.*)` is a **silent no-op** — it never matches the resolved path.
    Anchor against `node_modules/`, e.g.
    `^(node:)?(node_modules/)?(@nestjs/.*|pg|typeorm|…)` (the
    `domain-no-framework-imports` and `application-no-framework-imports` rules
    both use this form).
- **Use cases inject only domain ports** — e.g. `IQueueRepository`,
  `ICounterRoutingRuleRepository`, `ITransitionPolicyResolver` — never
  infrastructure concretions. A use case returns a transport-agnostic **DTO**
  (discriminated-union result), never the aggregate itself; the
  interface-adapter layer maps it to HTTP/WS. Command + result DTOs are
  co-located with the use case.
- **Per-execution policy resolution (load-bearing):** the active `StateMachine`
  (from `SystemConfiguration`) is supplied to a use case as an
  `ITransitionPolicyResolver` (domain port, `TRANSITION_POLICY_RESOLVER` Symbol
  token) by the interface-adapter/DI layer — **not** a snapshot
  `ITransitionPolicy` and **not** loaded by the use case. Each use case
  resolves the active policy per execution (`const policy = await
  resolver.getActivePolicy();`) and passes the **synchronous**
  `ITransitionPolicy` into the aggregate's transition methods. Required
  because: (1) the app must boot **before** the first-run wizard creates
  `SystemConfiguration`, so resolving a policy eagerly at boot would throw
  `SystemNotConfiguredException` and crash startup (and break the wizard
  itself); (2) `QueueTicket.transitionTo` is synchronous `void` and calls
  `policy.isAllowed` inline + throws, so a lazy async proxy is not viable.
  `StateTransitionValidator` (interface-adapter) implements the resolver port,
  reading the singleton `SystemConfiguration`; all queue command use cases
  share this one resolver.

### NestJS DI

- **Interface ports are erased at runtime** — NestJS can't resolve them by type
  metadata. Inject each via a co-located Symbol token + `@Inject` (see
  `QUEUE_EVENT_PUBLISHER` in `event-publisher.port.ts`), and bind it in the
  module with `{ provide: <token>, useClass: <impl> }`.
- **`useClass` vs `useFactory` for Symbol-bound deps:** `useClass: X` makes
  NestJS resolve `X`'s constructor params by their *type token*. If a param is a
  class whose only provider is bound to a **Symbol** (e.g. the `pg.Pool` bound
  to `PG_CONNECTION`), there is no class-token provider for `Pool` and DI
  throws `Nest can't resolve dependencies of X (?)` at boot. Wire such repos
  through a factory that injects the Symbol: `{ provide: <repo-token>,
  useFactory: (pool) => new X(pool), inject: [PG_CONNECTION] }`. The in-memory
  repos have no-arg constructors so `useClass` is fine; the Postgres repos
  (which take `pool: Pool`) all use `useFactory`. This failure class is
  invisible when no test boots the profile — the Postgres profile only boots
  under `QMS_PERSISTENCE=postgres` (DoD-4), so a wiring bug ships silently
  until CI sets the env var.
- **No-op default-param impls live in the domain, not infrastructure.**
  `NoOpTransactionManager` (and any sibling null-object default) is co-located
  with its port in `src/domain/shared/` because application use cases reference
  it as a default constructor param (`new NoOpTransactionManager()`). Moving
  it to infrastructure would make the application layer import infrastructure
  — a direct `application-no-infrastructure` dep-cruiser violation. The no-op
  is pure (no framework deps), so domain purity (NFR-MNT-01) holds. Do not
  "fix" this by relocating no-op defaults to infrastructure.
- **`useExisting` to alias one repo instance to two port tokens:** the queue
  repos implement both `IQueueRepository` and `ITicketArchivePort`; bind
  `TICKET_ARCHIVE_PORT` via `useExisting: QUEUE_REPOSITORY` so one instance
  serves both tokens (works for `useClass` and `useFactory` bindings).

### Realtime stack

The WS gateway uses `@nestjs/platform-ws` (`WsAdapter`) and shares the HTTP
port at path `/ws` (a gateway with no explicit port binds `noServer` onto the
HTTP server's `upgrade` event). The app boots on `@nestjs/platform-express` —
both platform packages must stay installed or `NestFactory.create` fails with
"No driver (HTTP) has been selected."

**`QueueEventDispatcher` import gotcha:** the dispatcher is NOT re-exported by
the `src/application/queue` barrel — import it via the direct path
`src/application/queue/queue-event-dispatcher` (as `realtime.module.ts` and
`tickets-api.module.ts` do), not from the `application/queue` index.

### Queue command lifecycle events

The six command use cases (call-next/serve/complete/skip/recall/transfer) drain
the aggregate's domain events by calling `await dispatcher.dispatch(ticket)`
after `queue.save(ticket)` — without this the aggregate records
`TICKET_CALLED` / `STATUS_UPDATED` / `TICKET_TRANSFERRED` but they never
broadcast (FR-ENG-04). `dispatch(aggregate)` pulls events from an
`AggregateRoot`; for **non-aggregate system events** (the daily reset rolls
the whole sequence, not one ticket) use the sibling
`await dispatcher.dispatchEvents(events: readonly DomainEvent[])`, which
forwards a free-standing event list to the same `IQueueEventPublisher`.
`DailyQueueResetEvent` (type `SYSTEM_RESET`) carries a sentinel
`SYSTEM_AGGREGATE_ID = 'system'` (from `daily-queue-reset.event.ts`) since
`DomainEvent` requires an `aggregateId` but no `SystemAggregate` exists.

Event counts a realtime test must collect:
- **Transfer emits two events** — `STATUS_UPDATED` (CALLING → WAITING,
  actionLabel "Pindah Kategori") **and** `TICKET_TRANSFERRED` (transfer is a
  first-class transition). Collect 2, not 1.
- **Recall emits two events (QUE-4)** — `QueueTicket.recall` records a
  `STATUS_UPDATED` (actionLabel "Panggil Ulang") **and** a `TICKET_CALLED`
  carrying the retained `counterId` + `ticketNumber`, mirroring `markCalling`
  (a recall is a re-call to the same counter — the ticket retains its
  `_counterId`; `RecallTicketUseCase` takes no `counterId`). The `TICKET_CALLED`
  is guarded on `_counterId !== null` (defensive against a degenerate custom
  machine that reached `SKIPPED` without a prior call; never trips on the PRD
  default machine). This is the recall-restore fix: the TV board re-shows the
  ticket + re-announces audio via the existing `TICKET_CALLED` path with no
  TV-side change. Collect 2, not 1.
- The other single-transition commands (serve/complete/skip) emit exactly one
  `STATUS_UPDATED`.

**General rule — fix a missing realtime projection at the domain event source,
not per-consumer:** when a default-flow operation is invisible to a realtime
consumer because the aggregate omits the event the consumer projects, emit
the semantically-correct event from the aggregate (recall emits
`TICKET_CALLED` — a re-call is a call) so every consumer's existing path
handles it with no per-consumer retained-state patch.

**General rule — when a domain operation emits a sequence of events that must
be reconciled together, the projection must keep the intermediate state visible
through the earlier event(s) and resolve at the event carrying the
authoritative payload, never drop at the first event.** Instance: a transfer
of the *active* ticket emits `STATUS_UPDATED` (CALLING → WAITING) then
`TICKET_TRANSFERRED` (carries the authoritative `{ toCategoryId,
toTicketNumber }`). `WAITING` must stay **non-terminal** in `STATUS_UPDATED`
so the ticket remains visible on the board between the two events;
`TICKET_TRANSFERRED` then evicts it from `active` and re-adds to `waiting`
only when the new category is one of the counter's. Treating `WAITING` as
terminal in `STATUS_UPDATED` would race the two-event sequence — the ticket
vanishes before `TICKET_TRANSFERRED` re-adds it (and if that event were
lost/delayed, it would vanish permanently).

**General rule — a generic endpoint wrapping an aggregate's generic transition
method must reject, at the backend boundary, any target that has a dedicated
command endpoint owning domain-specific side effects.** Otherwise a direct
API call bypasses those side effects and silently corrupts the downstream data
model: e.g. reaching `COMPLETED` via `POST /api/queue/:id/transition` would set
`_currentStatus` but leave `_completedAt` null (the generic path owns no
lifecycle timestamp), corrupting the analytics `AVG(...)` over `completed_at`.
The controller rejects a canonical target with 400 ("use the dedicated
endpoint") **before** invoking the use case, reusing
`isCanonicalStatus`/`CANONICAL_STATUSES` (`domain/queue`) as the single source
of truth for the 5 default states — the client mirrors this routing via
`COMMAND_BY_TARGET`, but the **backend is the authority** so the contract
holds against any direct API call.

### Ticket generation & daily sequence

The kiosk takes a ticket via `POST /api/tickets` → `CreateTicketUseCase`,
which resolves the category, reserves a per-category, per-day number (`A-001`)
from the `ISequenceRepository` port (atomic — no dupes/gaps, NFR-REL-02), mints
a `QueueTicket` (WAITING), persists, and broadcasts `TICKET_CREATED`. The
daily sequence key is `YYYY-MM-DD` in the store's **local** time (not UTC —
single on-premise box, NFR-SEC-01), owned by the **application layer** (a pure
`toDateKey(epochMs)` helper) and derived from an injected `clock` so the date
convention stays out of the pure domain and is testable. The
`ISequenceRepository` port carries a `SEQUENCE_REPOSITORY` Symbol DI token
like the other repo ports. True gap-free durability (reserve + insert in one
DB transaction) is the Postgres repo's job — the in-memory impl is tests/dev
only.

`CreateTicketUseCase` also computes `waitingAhead` (= same-category WAITING
count − 1, the just-issued ticket being the newest) **inside the existing
`txManager.runInTransaction` callback** (after `queue.save`) via
`countWaitingByCategory(categoryId)` on the `IQueueRepository` domain port
(LSP — in-memory filters/`length`, Postgres `SELECT COUNT(*)::int …` via
`withDbClient`, enlisting on the ambient tx client so the just-inserted row is
visible and concurrent uncommitted inserts are excluded → deterministic).
`waitingAhead` rides the `CreatedTicketDto` (additive — only the kiosk
consumes the REST DTO; the WS `TICKET_CREATED` wire event is separate, carrying
only `{ ticketNumber, categoryId }`, so no WS consumer is affected). The
receipt renders "Anda antrian ke-{N} dari {N}" where N = `waitingAhead + 1`.

### Daily reset engine

`ResetDailyQueueUseCase` (`application/queue`) owns only
`ISequenceRepository` + `QueueEventDispatcher` + an injected `clock`. It
derives `date = toDateKey(clock())` internally, calls
`sequences.resetDaily(date, resetTo)`, and emits
`DailyQueueResetEvent(SYSTEM_AGGREGATE_ID, resetTo, date, clock())` via
`dispatchEvents`. **Anti-corruption boundary:** the use case imports **no**
Store-Config type — the interface-adapter layer (`SystemAdminController`,
`DailyResetSchedulerService`) reads `DailyResetPolicy.resetTicketNumberTo`
from `SystemConfiguration` and passes only the scalar `resetTo` into the
command. The manual trigger is `POST /api/system/daily-reset`; the automatic
trigger is `DailyResetSchedulerService` (`infrastructure/scheduler/`), an
`@Injectable() OnModuleInit` that reads the config at boot and, if the policy
is `AUTOMATIC_CRON` with a cron expression, arms a `@nestjs/schedule`
programmatic `CronJob` calling the use case. `ScheduleModule.forRoot()` is
imported in `AppModule` for the `SchedulerRegistry`.

**Scheduler re-arm + cron enforcement + policy-change audit (QUE-32):** the
scheduler is no longer boot-armed-only. `DailyResetSchedulerService`
implements a non-repository domain port `IDailyResetSchedulerPort`
(`domain/store-config/scheduler.port.ts`, `DAILY_RESET_SCHEDULER` Symbol
token — same shape as `ITransitionPolicyResolver`). Its `reArm()` re-reads the
persisted `SystemConfiguration` and **idempotently reconciles** the armed cron:
arm / disarm (MANUAL or unconfigured) / no-op (desired cron already matches
the tracked `armedCron` field, so a categories-only save does not churn the
running cron). `onModuleInit` now just calls `reArm()`.
`SaveSystemConfigurationUseCase` gets an optional `scheduler:
IDailyResetSchedulerPort | null = null` constructor param (null = skip, no
no-op class needed — distinct from `NoOpTransactionManager` which is a
called-every-time default) and calls `await this.scheduler.reArm()`
**post-commit**, gated on the policy actually having changed (or initial
setup) — so a rolled-back save never re-arms to an un-persisted policy
(NFR-REL-02, the same dispatch-after-commit pattern as `SYSTEM_RESET`).
Wiring: `SchedulerModule` binds
`{ provide: DAILY_RESET_SCHEDULER, useExisting: DailyResetSchedulerService }`
+ exports it; `SystemConfigApiModule` imports `SchedulerModule` and injects
the token into the `SaveSystemConfigurationUseCase` factory. No circular dep.
- **Construct-before-delete robustness (NFR-REL-02):** `reArm()` builds the new
  `CronJob` **before** deleting the old registered one — the `cron` library
  parses + validates the expression in the constructor (the realistic throw
  site), so a throw leaves the previously-armed cron intact instead of leaving
  the store with no automatic daily reset while the DB has already committed
  the new policy. Apply this construct-validate-before-destroy pattern to any
  future re-arm/replace of a long-lived resource whose destruction is not
  auto-recovered.
- **Backend cron-format enforcement:** `DailyResetPolicy.of` validates the
  5-field cron **format** (not just non-emptiness) for `AUTOMATIC_CRON` via a
  pure domain helper `isValidCronExpression`
  (`domain/store-config/value-objects/cron-expression.ts`) that **mirrors**
  `admin-service/src/lib/cron.ts` exactly (5 fields; ranges menit 0-59 / jam
  0-23 / tanggal 1-31 / bulan 1-12 / hari 0-7 with 0 and 7 = Sunday; `*`,
  comma lists, ranges `a-b`, steps `*/n` / `a-b/n` / `a/n`; no named
  months/days, no `@macros` / `L` / `W` / `#`). Localized duplication across
  the backend-domain / frontend-bundle boundary is intentional (separate
  build trees; a shared package for one pure function would cross-couple
  them) — the two grammars MUST stay in lock-step; a divergence is a bug.
- **Exception choice:** a malformed cron throws `InvalidValueObjectException`
  (→ 400), NOT `InvalidArgumentException` — a malformed cron is a malformed
  value object, and `InvalidArgumentException` is reserved for use-case-level
  business guardrails where the value is well-formed but not permitted.
- **`DAILY_RESET_POLICY_CHANGE` audit action** is recorded by
  `SaveSystemConfigurationUseCase` inside the same tx as
  `STATE_SCHEMA_CHANGE` / `ROUTING_CHANGE`, but **change-gated** (unlike those
  two, which are recorded on every save): only when
  `!oldPolicy.equals(newPolicy)` (`ValueObject.equals` structural deep-equal),
  with before/after snapshots.

### PostgreSQL persistence & durability

- **`PersistenceModule.forRoot()`** is a `DynamicModule` reading
  `QMS_PERSISTENCE` (default `in-memory`); the `postgres` profile binds the
  six repo tokens + `TRANSACTION_MANAGER` + `PG_CONNECTION` (a `pg.Pool`
  factory) to Postgres concretions and **excludes `DevSeedService`** (the
  wizard is the real seed; a dev seed would write a config and block the
  first-run redirect).
- **The migration runner (`PostgresMigrationRunner`, `OnModuleInit`) is the
  only schema authority** — no Prisma/TypeORM — applying `migrations/*.sql`
  idempotently into a `_migrations` table (SHA-256 checksums). **Build asset
  gotcha:** `tsc` does not copy `.sql` (or any non-TS asset) to `dist`, so the
  runner's `readdirSync(migrationsDir)` throws and is caught, making it
  **silently no-op** — no tables are created and the scheduler's `onModuleInit`
  query then fails with `42P01`. The `postbuild` script copies the migrations
  dir into `dist/…/migrations`; any new non-TS runtime asset needs the same
  treatment.
- **Gap-free sequence reservation (NFR-REL-02)** is via the
  `ITransactionManager` port (domain): `PostgresTransactionManager` wraps
  `BEGIN`/`COMMIT` with an `AsyncLocalStorage` ambient client (confined to the
  postgres impl); the in-memory impl is a pure pass-through (`return work()`).
  Use cases that reserve-then-save (`CreateTicketUseCase`,
  `CallNextTicketUseCase`, `ResetDailyQueueUseCase`,
  `SaveSystemConfigurationUseCase`) take an **optional** `txManager`
  constructor param defaulting to `new NoOpTransactionManager()` so unit specs'
  direct construction stays unbroken — the wired profile injects the real
  manager.
- **Durability contract + startup recovery (QUE-28, NFR-REL-02):** enforce
  `synchronous_commit=on` **per connection** via the pool `onConnect` **config
  option** in `createPgPool` (a `user`-context GUC — `SET` persists for the
  connection session, so commits wait for WAL flush regardless of the server
  default), and verify `fsync=on` at boot via `PostgresDurabilityProbe`
  (`@Injectable() OnModuleInit`, postgres profile only — `fsync` is
  `postmaster`-context, settable only at server restart; the probe `SHOW
  fsync` and throws `DurabilityDegradedException` if not `on` — **fail-fast**,
  not warn; a queue that could lose numbers must not boot). The probe is
  schema-independent (needs only the pool), so no `OnModuleInit` ordering
  constraint vs. `PostgresMigrationRunner`. No audit entry for boot recovery;
  no startup state reconciliation/mutation (PRD says "recover exactly" —
  auto-rewinding CALLING→WAITING would violate it).
  - **`onConnect` vs `pool.on('connect')` gotcha:** the `pool.on('connect',
    client)` **event** does NOT await promises/async setup, so a `SET` there
    races the client handout. Use the `onConnect` **config option** (`new Pool({
    onConnect: async (client) => { await client.query('SET …') } })`) —
    `pg-pool` wraps it in `_promiseTry(...).then()` and awaits before handing
    the client out, destroying it on rejection. `@types/pg` types `onConnect`
    as `(client) => void` (sync), but an `async` fn is assignable and is
    awaited at runtime — the typed signature understates the runtime.
- **In-memory rollback caveat:** `NoOpTransactionManager` is a pure
  pass-through, so `InMemoryQueueRepository.archiveTicketsBefore` does NOT roll
  back on a `resetDaily` throw (the Postgres impl does) — the in-memory impl is
  explicitly **not** an LSP substitute on the archive+reset failure path
  (documented dev-only limitation; gap-free durability is the Postgres repo's
  job).

### Domain value-object rules

- **Construction failures throw `InvalidValueObjectException`, never a bare
  `Error`.** A shared domain value object's `of`/construction method (e.g.
  `Identifier.of`) must throw `InvalidValueObjectException` (a `DomainError`),
  not a plain `Error`, so `DomainExceptionFilter` (`@Catch(DomainError)` only)
  maps a malformed value to HTTP 400 instead of letting a bare `Error` escape
  the filter and surface as 500. Fix at the **source** — the VO owns its
  construction-failure semantics (SRP) — not by wrapping each untrusted-input
  call site (which would leave a semantically-wrong bare `Error` in the shared
  kernel and force every new caller to repeat the wrap, an OCP smell). Blast
  radius to trusted/DB-reconstitution paths is an accepted never-path tradeoff:
  every write goes through `Identifier.generate()` (strict v4 UUID + strict
  `isValid`), and the filter rethrows on non-HTTP hosts
  (`host.getType() !== 'http'`) so scheduler/boot/WS reconstitution preserves
  its prior 500-equivalent behavior.
- **`InvalidArgumentException` is a domain error for use-case-level business
  guardrails** (`domain/shared/errors.ts`), distinct from
  `InvalidValueObjectException` (a malformed value object) and
  `InvalidStateTransitionException` (a forbidden state move): the value is
  well-formed, just not permitted by a use-case rule. The exception carries no
  business rule itself (the floor value lives in the application layer); it is
  transport-agnostic, mapped to 400 by `DomainExceptionFilter`. Mirrors
  `SystemNotConfiguredException`.
- **Declare module-level `const`s BEFORE a domain VO class that references
  them in a `static` field (TDZ).** A `static DEFAULT = BrandColor.of('#2563eb')`
  initializer runs **during class evaluation** — before any later `const
  HEX_RE = /…/` (or helper function) later in the module is initialized, so it
  throws `ReferenceError: Cannot access 'HEX_RE' before initialization`.
  `const` declarations are block-scoped and not hoisted for *initialization*
  (the temporal dead zone); `static` class fields do not defer. So a VO with a
  static default that calls its own `of()` against a module-level
  regex/helper must declare every such `const`/`function` **above** the
  `class` declaration. (`BrandColor` hit this: `HEX_RE`/`OKLCH_RE`/`normalizeOklch`
  lived after the class and `static DEFAULT` blew up at import — 29 test
  suites failed. `Identifier` dodged it only because it has no `static DEFAULT`
  calling `of()` against a module `const`.) Apply to any new VO that mints a
  `static DEFAULT`/`static` factory referencing module-level helpers.
- **Relocate invariants when deleting a guardrail VO.** When a domain value
  object that enforced an invariant (e.g. the deleted `AudioQueueItem`
  required `counterId` to be a positive integer) is removed as dead code, its
  invariant must not silently vanish — surface it at the new enforcement
  site. Either re-guard at the replacement (a one-line
  `Number.isInteger(x) && x >= 1` throw) or document the precondition on the
  successor's signature (`@pre …`), naming the upstream guarantee that makes
  it safe. Deleting the VO without relocating the invariant lets bad input
  silently degrade (e.g. `buildCallFragments` would emit a `-.mp3` fragment
  for a negative id) instead of failing fast.

### Admin/wizard client conventions

The wizard and operational `AdminPanel` are aimed at a non-technical store
manager, so user-visible text must never leak internal terms ("PRD §7",
`FIFO_GLOBAL`/`CATEGORY_PRIORITY`, "cron expression", "State Machine", a raw
numeric `Counter {id}`).

- **Render enum values via a friendly label map, never raw enum/internal text in
  user-visible copy; constrain cron input to a time picker and derive the cron
  client-side rather than making the manager type one.** Two shared pure
  helpers in `admin-service/src/lib/` keep friendly text in one place:
  `labels.ts` (`PRIORITY_POLICY_LABELS` + `DAILY_RESET_MODE_LABELS`,
  `Record<Enum,string>` maps) and `daily-reset.ts` (`timeToCron`/`cronToTime`).
  The enum stays as the `value=` attribute (wire contract unchanged —
  `PUT /api/system/config` still sends enum values, never the friendly text);
  the `<option>` body and review/render text read from the label maps. Step 4's
  raw cron text input is `<input type="time">` deriving the 5-field daily cron
  as `MM HH * * *` (minute-then-hour; `08:30` → `30 8 * * *`). The form's
  `cronExpression` source of truth is rewritten **only** by the picker's
  `onChange`, so a granular cron set via direct API is **not silently coerced**;
  `validateCronExpression` still guards it (defense-in-depth for a corrupt
  prefill). Both surfaces share the helpers so the daily `AdminPanel` stays
  consistent with the wizard.
- **Mirror core-api value-object invariants in client-side validation AND use
  constrained inputs (dropdowns over the live list) to make invalid states
  unconstructable, rather than relying on a backend 400 round-trip.** Wizard
  instances: `validateCustomStateMachine` mirrors `StateSchema.of` (≥1 state,
  non-empty unique names) and `StateMachine` ctor (≥1 transition, `from`/`to` ∈
  schema, no duplicate `from->to` edges, non-empty `actionLabel`); custom mode
  transitions use `<select>` dropdowns constrained to the current `states`
  list (structurally prevents the backend's "transition references states not
  in schema" 400); a state referenced by any transition cannot be removed;
  renaming a state propagates to every referencing transition. `Lanjut` is
  disabled while invalid. `validateCustomCategories` mirrors the backend
  `Category` VO (code `^[A-Z]+$`, non-empty name, no dupes; per-row error
  prefixes so the dedup `Set` keeps distinct rows distinguishable).
- **Client-only presets (`mode: 'default' | 'custom'`) are stripped at finalize,
  inferred on prefill by deep-equal.** The wizard's state-machine step and
  category step each carry a `mode` field **never sent to core-api** (the
  `PUT` payload is always the full graph/list; `mode` is stripped in
  `finalize` and force-resets to the PRD §7 default when `'default'`, so a
  half-edited custom graph a manager abandoned cannot leak onto the wire — no
  `StateMachineDto` contract drift).
- **Category id-preservation is load-bearing.** `QueueTicket.categoryId`
  stores the category UUID, and `SaveSystemConfigurationUseCase.buildCategories`
  reuses a provided `id` (`Identifier.of(id)`) but regenerates it when `id` is
  absent — so any client re-editing categories post-setup MUST send the
  existing `id` for unchanged categories (omit it only for newly added ones),
  or it mints new ids and orphans every existing ticket's `categoryId`.
  - **The default-mode force-reset draws its id pool from the prefill
    (`loadedCategoriesRef`), NOT the live `form.categories`** — otherwise a
    custom detour that removes a row, then switches back to default, would
    mint fresh UUIDs and orphan every ticket that referenced the removed code.
    (The state-machine force-reset can blindly use `DEFAULT_STATE_MACHINE`
    because the graph carries no ids; categories diverge because they do.)
  - **`setCounterCount` uses `max(existing counterId)+1`, not `length+1`** — a
    re-edit can load a gapped/non-sequential set of counterIds and `length+1`
    would collide (the backend `buildRoutingRules` rejects duplicate
    counterIds with a 400). `setCounterCount` syncs `routingRules` length
    (append default-named counters / truncate, **no renumber** — preserves
    counter identity) and clamps `>=1`.
- **Client boundary id↔code mapping:** `GET /api/system/config` returns
  routing `assignedCategoryIds`, but `PUT` expects `assignedCategoryCodes` —
  the admin/wizard client maps id→code on load (via the categories' id→code
  map) and sends codes; the backend resolves codes→ids at save.
  `Identifier.of` only accepts a v4 UUID, so fixtures/payloads must use real
  v4 UUIDs, not arbitrary slugs like `'cat-a'`.
- **Any receipt/print field sourced from a mount-time fetch must be resolved
  before the user-action that consumes it is enabled** — gate the action on
  the fetch, don't fire-and-forget a field that becomes user-visible. Kiosk
  instance: the store-name fetch (`IKioskApi.getStoreName()` reusing
  `GET /api/system/config`) is `Promise.allSettled`-awaited alongside
  `listCategories` before category buttons become interactive; a store-name
  failure never blocks the flow (the receipt just omits the header line).
- **Admin operational config panel (FR-ADM-01):** post-setup the manager edits
  categories, counter routing, and the daily-reset policy in place at
  `/admin`; the wizard stays the guided first-run and the editor for
  `storeName` + the state machine. It reuses the existing audited `PUT
  /api/system/config` full save (DRY — no new REST surface): GET the full
  config, edit the in-scope sections, **passthrough** unchanged `storeName` +
  `stateMachine`, PUT the full payload back.

### Daily reset semantics & archive

- **`archivePreviousDayData` flag:** `true` (default) relocates every ticket in
  the active store with `created_at < startOfLocalDay(now)` into
  `archived_tickets` *before* the sequence reset (regardless of status —
  "active" = "in the active table", not "non-terminal"); `false` is a **no-op**,
  not a purge (the AC says "arsipkan"). A dedicated `ITicketArchivePort` (one
  method, `domain/queue`) is added on ISP grounds — the reset use case needs
  only the archive op, not the full `IQueueRepository` surface; the concrete
  queue repos implement both ports.
- **Atomicity (NFR-REL-02):** archive + reset + (manual) audit all run inside
  one `txManager.runInTransaction(...)` callback; the `SYSTEM_RESET` event
  dispatches **after** commit (a rolled-back reset is never broadcast). The
  Postgres archive is a single `WITH moved AS (DELETE … RETURNING …) INSERT …
  SELECT` CTE enlisting on the ambient `AsyncLocalStorage` client.
- **Audit:** `AuditAction.ARCHIVE_PREVIOUS_DAY` is recorded **manual path only**
  (`command.actor` set), mirroring `MANUAL_RESET` scoping — the automatic cron
  reset is not audited.
- **`startOfLocalDay(epochMs)`** lives in `application/shared/date.ts` next to
  `toDateKey`, keeping the date convention out of the domain; the archive
  threshold is `created_at < startOfLocalDay(now)` (no `date_key` column —
  avoids timezone-fragile SQL).
- **Default policy gotcha:** the default `DailyResetPolicy` has
  `archivePreviousDayData = true`, so `POST /api/system/daily-reset` **always**
  returns `archivedCount` in its result DTO (0 when no prior-day tickets) — the
  integration spec's `toEqual` must include it, and a manual reset records
  **two** audit entries (`ARCHIVE_PREVIOUS_DAY` then `MANUAL_RESET`), not one.
- **Transaction-log cleanup (FR-ADM-02 / NFR-SEC-02):** `purgeArchivedBefore(thresholdMs)`
  on `ITicketArchivePort` purges `archived_tickets` ONLY — **`audit_log` is
  never touched** (the audit trail is the compliance record, preserved
  indefinitely). `MIN_RETENTION_DAYS` (7) lives in the **application layer**
  (a use-case-level business guardrail, not a `SystemConfiguration` field);
  an under-floor / non-integer `retentionDays` throws `InvalidArgumentException`
  **before** the tx opens so an illegal cleanup burns no rows (NFR-REL-02
  pattern). The purge + `TRANSACTION_LOG_CLEANUP` audit append run inside one
  `ITransactionManager.runInTransaction`; the cleanup is **actor-gated** like
  `MANUAL_RESET`. `POST /api/system/cleanup-transaction-log` threads only
  scalars (`retentionDays`, `actor`). The audit READ surface is not duplicated
  here — `ListAuditEntriesUseCase` + `GET /api/audit/log` already ship (see
  Reporting). `actor: 'admin'` is a hardcoded string literal — the audit trail
  cannot distinguish which manager performed a destructive op; out of scope
  until an auth/identity layer lands.

### Reporting & analytics (FR-ADM-03)

- **CQRS read side:** `GET /api/reports/daily?date=`,
  `GET /api/reports/counters/:id?date=` (`ReportingController`, `api/reports`),
  `GET /api/audit/log` (`AuditLogController`, `api/audit`), each backed by a
  framework-free use case injected with a port (`REPORT_QUERY_PORT` Symbol
  token, `AUDIT_LOG_REPOSITORY`). The report repos implement `IReportQueryPort`
  and compute metrics by scanning `tickets` `UNION ALL` `archived_tickets`
  within the local day window — raw SQL aggregation, no aggregate
  reconstitution. A read returns `null` when no tickets exist for the date; the
  controller maps that to an empty-shape DTO (total 0, avgs 0, empty
  `perCategory`) so the dashboard has a clean zero state (never a 404).
  `ListAuditEntriesUseCase` lives in the **audit** bounded context (owns
  `AuditLogEntry`), mirroring the "read use case lives in the bounded context
  that owns the entity" precedent.
- **Lifecycle timestamp columns (the analytics data model):** migration
  `0003_ticket_lifecycle_timestamps.sql` adds `called_at`/`served_at`/
  `completed_at BIGINT` (idempotent `IF NOT EXISTS`) to both tables; the
  aggregate sets them on the named transitions — `markCalling` sets `calledAt`,
  `startServing` sets `servedAt`, `complete` sets `completedAt`; `recall`
  (SKIPPED→CALLING) re-sets `calledAt` (re-announce); `transferTo` clears all
  three to `null` (transfer re-enters the queue as a fresh ticket — new
  lifecycle). `reconstitute` gains 3 params → every call site (in-memory repo,
  Postgres repo, dev-seed, integration specs) must pass them. Postgres
  `AVG(...) FILTER (WHERE ...)` skips tickets that never reached the transition;
  `COALESCE(..., 0)` keeps the metric at 0 when no ticket reached it.
- **Shared date util + anti-corruption:** the local-date helpers (`toDateKey`,
  `startOfLocalDay`, `startOfLocalDayFromKey`) live in
  `src/application/shared/date.ts` — owned once in the application layer so the
  date convention stays out of the pure domain (NFR-MNT-01) AND so a reporting
  or audit consumer does **not** reach across into the queue bounded context
  for a date utility. Queue-context consumers re-export `toDateKey`/
  `startOfLocalDay` from `application/queue/create-ticket.use-case` for backward
  compat; new non-queue consumers import from `application/shared/date`
  directly.
- **TS re-export gotcha:** `export { foo } from './x'` **re-exports but does
  NOT bind `foo` in the module body** — to *use* the helper inside the same file
  you need a separate `import { foo } from './x'` alongside the `export … from`.
  Forgetting the `import` compiles the re-export fine but TS2552s on the call
  site.
- **In-memory CQRS read-side seam:** the in-memory report repo needs live
  ticket-store access, but `allActive()` is a **reporting-only seam on the
  concrete `InMemoryQueueRepository`**, NOT a new method on the write-side
  `IQueueRepository` port (the write port stays free of list-all read methods —
  SRP/ISP). It is wired via `useFactory` injecting the `QUEUE_REPOSITORY`
  singleton + `CATEGORY_REPOSITORY`. The Postgres read side needs no such seam
  (it queries the tables directly via `withDbClient`).
- **Acceptance-test timing gotcha:** in-process supertest calls are
  sub-millisecond, so `completedAt === servedAt` and the service-time delta
  rounds to 0. Insert real `setTimeout` sleeps (`await sleep(2)`, jest real
  timers) between lifecycle steps (create → call → serve → complete) for
  deterministic ≥1ms deltas so `avgWaitTimeMs`/`avgServiceTimeMs` are non-zero.
- **SheetJS offline bundling (NFR-REL-01):** the admin-service xlsx export
  vendors `xlsx@0.18.5`, generated client-side via `XLSX.writeFile` (Blob
  download, fully offline). SheetJS bundles OOXML/ODF **XML namespace
  identifier URLs** (`http://schemas.openxmlformats.org/…`, `http://purl.org/…`,
  `http://purl.oclc.org/…`, `http://openoffice.org/…`,
  `http://docs.oasis-open.org/…`, `http://schemas.microsoft.com/…`,
  `http://sheetjs.com`, `http://macVmlSchemaUri`) — these are XML namespace
  URIs / metadata written into the `.xlsx`, **never fetched at runtime** (same
  class as `w3.org`). They surface in a `grep https?:// dist/assets` and must be
  whitelisted in the `offline-assets.acceptance.spec.ts` `ALLOWED_HOSTS` with a
  rationale comment, not treated as a runtime network call.
- **Hand-roll small visualizations from the DTO the page already loads rather
  than vendoring a chart library** (Recharts/d3 would bloat the bundle for a
  2–3-bar chart and would need offline vetting, NFR-REL-01) — mirroring the
  audio-sequencer minimal-dependency precedent. `RecapCharts` renders three
  hand-rolled offline SVG bar charts (one per metric, one bar per category) fed
  by the existing `DailyReportDto.perCategory` slice. Single-series magnitude →
  one accent hue (`--accent`) for all bars, length encodes value, category code
  labels it; text never wears the data color (labels in `--text`/`--text-muted`);
  per-bar `<title>` is the hover/a11y channel; the sibling Per Kategori table is
  the always-available table view.

### REST surface separation

Read-only caller workspace (`GET /api/counters`, `GET /api/queue`) lives in
`RestApiModule`. Mutation endpoints get their own module by concern — kiosk
ticket-creation is `TicketsApiModule` (`POST /api/tickets`), kept separate so
the read-only module's purpose stays clean (SRP). Caller command endpoints
(`POST /api/queue/call-next`, `…/:id/serve|complete|skip|recall`,
`…/:id/transfer`, `…/:id/transition`) live in `QueueCommandsApiModule`
(`@Controller('api/queue')`, sharing the `api/queue` prefix with the read-only
`QueueController` — reads + commands under one resource prefix, commands as
POST sub-paths). The system-admin daily-reset surface
(`POST /api/system/daily-reset`, `POST /api/system/cleanup-transaction-log`)
is its own `SystemApiModule` (SRP). The use-case **wiring** for all queue/system
use cases is factored into one `QueueOperationsModule` (application layer, no
controllers) — it imports `PersistenceModule` + `RealtimeModule` +
`SystemConfigModule` and provides each framework-free use case via a factory
injecting the repo tokens + `QueueEventDispatcher` + `TRANSITION_POLICY_RESOLVER`.
`SystemConfigModule` binds the `TRANSITION_POLICY_RESOLVER` port to
`StateTransitionValidator`.

**Read use cases live in the bounded context that owns the entity they read:**
`ListCategoriesUseCase` (`GET /api/categories`) lives in `application/queue`
because `Category` is a Queue-context entity, and joins the read-only
`RestApiModule` — even though categories are also referenced by
`CounterRoutingRule` in Store Config, the read stays in its owning context and
does **not** join routing data (anti-corruption).

### Gateway & deployment

- **Compose boot-order:** `gateway` must `depends_on core-api-service` with
  `condition: service_healthy`, and `core-api-service` must carry a healthcheck
  (`/api/health` via `wget`, which ships in `node:20-alpine` — no curl).
  Without it, nginx starts as soon as the container process does and 502s
  through the ~1–2 s Nest bootstrap + migration-runner window. `/api/health`
  (`HealthController`) answers pre-wizard, so it is a true liveness probe. The
  four static-PWA frontends stay on `service_started` (their nginx is ready
  instantly — no healthcheck needed).
- **Gateway first-run guard (FR-WZD-01):** while
  `isInitialSetupCompleted == false` the gateway must redirect **all** HTTP
  access to `/wizard` — the PRD is strict here ("semua akses HTTP"), and PRD
  wins over any client-side-only approach. nginx can't read the DB, so the
  guard is an `auth_request` subrequest to core-api's
  `GET /api/system/setup-status` (the `auth_request` module ships in
  `nginx:alpine` — no Lua needed). That probe maps the boolean to the HTTP
  status itself: `200` when setup is complete, `403 { code: 'SETUP_REQUIRED' }`
  when not. It **must never throw** on a clean store — `auth_request` treats
  2xx as allow, 401/403 as deny, but any other status (a 409
  `SystemNotConfiguredException`, a 500) is a hard error, not a deny, so the
  deny has to be a real 403. That mapping is an interface-adapter concern done
  with `HttpException` (not `@Res`, to stay platform-agnostic at the Nest
  layer), kept out of the pure use case; the 403 uses a **distinct**
  `SETUP_REQUIRED` code so the gateway deny isn't confused with the 409
  `SYSTEM_NOT_CONFIGURED` the queue command surface throws. The `auth_request`
  is scoped to the **document request only** (`location = /kiosk/` etc.) — an
  unconfigured client is redirected before its HTML loads so it never fetches
  assets, and once setup is complete assets stream unguarded. **Exempt** from
  the guard (no `auth_request`): `/api/` (the wizard must PUT config + read
  setup-status), `/admin/` (wizard SPA host — must load to perform setup),
  `/wizard`, `/ws`, and `/`. The `/admin/` client-side `SetupGuard` stays as
  progressive enhancement.
  - **`nginx -t` standalone gotcha:** nginx resolves `upstream` hostnames
    (`core-api-service`) at config-load time against the container network's
    DNS; running `nginx -t` outside the compose network fails with "host not
    found in upstream" even when the config is valid. Validate syntax by
    `sed`-replacing the upstream hostnames with `127.0.0.1:3000` into a temp
    conf and running `docker run --rm -v /tmp/nginx.conf:/etc/nginx/nginx.conf:ro
    nginx:alpine nginx -t`.
  - `BootstrapService` (`infrastructure/bootstrap/`, `OnModuleInit`)
    formalizes "config re-readable at startup" — an eager, observable startup
    read of `SystemConfiguration` that logs the outcome across profiles; it
    does not cache or publish.
- **Topology smoke test:** `npm run compose:verify`
  (`scripts/verify-topology.mjs`) is the gate proving the compose topology
  serves every PRD route through the gateway. Tier 1 (no Docker daemon)
  validates `docker compose config` + asserts all seven PRD services are
  declared; tier 2 (when a daemon is up) boots the stack and asserts
  `/api/health` 200, the `/` + `/wizard` 301 redirects, and the four PWA routes
  200 via the gateway, then `docker compose down -v`. It is intentionally NOT
  part of `scripts/run-verify.mjs` so the per-service unit/build gate gains no
  Docker dependency.
  - **Gateway redirect assertion gotcha:** nginx emits an ABSOLUTE `Location`
    (e.g. `http://localhost/admin/`) for a relative `return 301 /admin/` (it
    resolves against the `Host` header), so route assertions must match
    `Location` by suffix (`endsWith('/admin/')`), not strict equality — and
    use Node's `http` module, not `fetch` (`redirect: 'manual'` returns an
    opaqueredirect response with status 0 and filtered headers, hiding the
    301).

### Frontend service conventions

Frontends are React-family; `caller-service` is a PWA. Keep them
offline-capable (bundle + precache all assets — vite-plugin-pwa; relative
`/api` + `/ws` URLs so they're same-origin behind NGINX with no per-service
config, proxied to `core-api:3000` by Vite in dev).

- **Vite + vitest config typing:** `vite.config.ts` imports `defineConfig`
  from `vitest/config` (not `vite`) whenever it carries a `test` field —
  otherwise `tsc -b` fails with `'test' does not exist in type
  'UserConfigExport'`.
- **PWA `base`/`start_url`/`scope` must match the NGINX route** (e.g.
  `/kiosk/`, `/caller/`) — otherwise an installed PWA's `start_url` resolves to
  the gateway root, not the service, breaking offline launch. Set them when
  scaffolding a new frontend. (All four existing frontends are already aligned.)
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
  frontends (`kiosk-service` onward) gitignore them. Because `caller-service`
  still tracks `tsconfig.tsbuildinfo`, running `npm run build` / `npm run
  acceptance` regenerates it and `git add -A` sweeps the churn into an
  unrelated PR — when staging a cross-service (esp. comment-only) PR after a
  gate run, stage the intended path(s) explicitly or `git checkout --` the
  `caller-service/tsconfig.tsbuildinfo` churn before committing. The durable
  fix is to `git rm --cached` it + add it to `caller-service/.gitignore` in
  the next caller-service-touching PR.
- **Touch-surface mutations need a synchronous double-tap guard — kiosk AND
  caller.** `disabled` only takes effect after a re-render, so two clicks
  landing in the same tick both pass a state-based guard. Flip the ref
  *before* the first `await` and reset it in `finally`; keep `disabled` as the
  visible affordance. Two taps must produce exactly one mutation. A state-only
  `pending` guard is NOT enough — it updates after a re-render, so two
  same-tick taps both see `pending === null` and both fire.
- **Caller WS projections recover missing fields from local state, never
  blank.** The wire event payloads are lossy by design: `TICKET_CALLED`
  carries only `{ ticketNumber, counterId }` (no `categoryId`), and
  `STATUS_UPDATED` carries only `{ from, to }` (no `ticketNumber`/`counterId`).
  When the projection needs a field the payload omits, recover it from the
  existing local entry (the prior `state.waiting` record for `TICKET_CALLED`)
  rather than blanking it to `''`/`null`. Fallback to `''` only if the prior
  entry is genuinely absent (defensive). Instance: a freshly-called ticket
  had `categoryId === ''` so the transfer chooser's "exclude current category"
  excluded nothing; reusing the waiting entry's `categoryId` makes the chooser
  correct on the live call-next path.
- **Reducer widening for generic transitions:** `queue-store.tsx`
  `STATUS_UPDATED` treats only `COMPLETED`/`SKIPPED` as leaving the counter;
  **every other** `to` (CALLING, SERVING, or a custom in-progress state like
  PREPARING) updates the status in place — the staff is still serving the
  ticket, just in a sub-state, so it stays on the board as the active ticket.
  The state machine carries no "terminal" metadata, so only the two
  PRD-default terminal states leave the counter (documented caller contract;
  a custom terminal state is not expressible today — future state-metadata
  config).
- **Step-form RTL tests: re-query DOM nodes after step re-entry, and use
  `fireEvent.change` for controlled numeric inputs bound to derived state.**
  The wizard renders each step with `{step === N && <section>…}`, so navigating
  away (next) **unmounts** the step and going back (Kembali) **recreates** the
  nodes — a `const input = screen.getBy…` captured on the first visit is a
  detached node after a round-trip. Re-query via `screen.getBy…` after the
  `findByTestId('step-N')` that confirms re-entry. Separately, a controlled
  numeric input whose `value` is derived from state cannot be set with
  `userEvent.clear` + `type`; use
  `fireEvent.change(input, { target: { value: '3' } })` to set it cleanly.
- **RTL: decorative media + fake-timer state updates.** An `<img alt="">`
  has the `presentation`/`none` ARIA role, not `img`, so
  `screen.getByRole('img', { hidden: true })` will not find it — query by tag
  (`container.querySelector('img')`/`'video'`) or give it a non-empty `alt`.
  A React 18 state update fired from a fake-timer callback needs
  `await act(async () => { await vi.advanceTimersByTimeAsync(n) })` to flush the
  re-render without an act warning.
- **RTL under `vi.useFakeTimers()`: query sync, click with `fireEvent`.**
  (1) `screen.findByText(...)` / any `waitFor`-based query polls via
  `setTimeout`, which fake timers do not auto-advance → it never polls and
  times out. After an `act`-wrapped `advanceTimersByTimeAsync` the re-render
  is already flushed, so read the DOM with the **synchronous**
  `screen.getByText(...)` (or `queryByText` for absence) instead.
  (2) `userEvent.click(...)` awaits internal pointer-event timers that fake
  timers do not auto-advance → it hangs. Use **`fireEvent.click(...)`**
  (synchronous, no internal timers) for fake-timer tests; reserve `userEvent`
  for real-timer tests. Separately, a **sync test that asserts only the initial
  render** but mounts a component that kicks off an async fetch on mount leaks
  an "update not wrapped in act" warning when the unresolved promise settles
  after the test body — stub the mount-fetch to `new Promise(() => {})` (never
  resolves).
- **Static CSS guards + both-mounted overlays under `css: false`.** jsdom
  (`css: false` in every frontend vitest config) does NOT apply stylesheets,
  so computed visibility/opacity/contrast are not testable. Two patterns:
  (1) **CSS-driven ACs** (a token swap, a fluid `clamp()`, a divider, a
  `@media` tier, `letter-spacing`) are guarded statically by a
  `styles.test.ts` that reads the CSS with `node:fs` `readFileSync` +
  `import.meta.url` (`dirname(fileURLToPath(import.meta.url))` — the services
  are `"type":"module"`, so `__dirname` is **not** defined at runtime),
  collapses whitespace (`/\s+/g → ' '`), and regex-asserts the rules. Do **not**
  use Vite's `?raw` import for this — under vitest's `css: false` a `?raw` CSS
  import resolves to an **empty string** (the css plugin still intercepts and
  strips it). `node:fs`/`node:path`/`node:url` need `@types/node` added to the
  service `devDependencies` and `"node"` appended to the root `tsconfig.json`
  `types` array (dev-only type dep, never bundled — no NFR-REL-01 concern).
  (2) **A both-mounted overlay** (both layers always in the DOM, crossfaded by
  a BEM `--hidden` modifier on opacity+visibility) is tested via
  `toHaveClass('--hidden')` / `not.toHaveClass('--hidden')` — **never**
  `toBeVisible()` (css:false doesn't compute visibility). When the hidden
  layer retains content, scope text queries to `within(visibleLayer)` — a
  global `queryByText('A-005').not.toBeInTheDocument()` fails because the
  hidden layer still renders the retained item in the DOM.
- **ARIA: a labelled cluster of immediate-action buttons is `role="group"` +
  `aria-label`, never `role="option"`.** `role="option"` implies a `listbox`
  parent + `aria-selected` semantics; it is wrong for buttons that fire a
  command on click. Wire a toggle→chooser with `useId()`: the toggle carries
  `aria-expanded` + `aria-controls={chooserId}`, the chooser `<div>` carries
  `id={chooserId}` + `role="group"` + `aria-label="…"`. Apply to any "pick
  one of N, then fire" affordance.
- **Skeleton loading-state a11y recipe.** A loading region is
  `role="status" aria-busy="true"` carrying a visually-hidden (`.sr-only`)
  text label for AT (e.g. "Memuat antrian…"); the placeholder shapes are
  decorative `<div className="skeleton …" aria-hidden="true" />`. The visible
  tree must NOT repeat the "Memuat…" text (no text-only loading state), so
  the label lives only in the `.sr-only` span. A skeleton shimmer is a pure
  opacity pulse (`@keyframes` 1↔.55), guarded by
  `@media (prefers-reduced-motion: reduce) { animation: none }` — no
  `background-position` gradient. `.skeleton` styles live in the service's
  own `styles.css`, NOT the vendored `_*.css` copies (no shared-token change
  → the drift gate stays green). Test with a fetch that never resolves
  (`() => new Promise(() => {})`) so `loadStatus` stays `'loading'`; assert
  `aria-busy`, `.skeleton` children, the `.sr-only` label text, AND that no
  ticket number / `workspace__hint` leaks before the snapshot resolves.
- **`--radius` is a per-service override in the service's own `styles.css`,
  NOT a shared token in `_tokens.css`.** Don't mint a `--radius-sm` (or any
  new shared token) for a single use — that would be a shared-token change +
  a re-sync across all four frontends for one site. Use `var(--radius)` (the
  per-service value, e.g. caller-service `14px`) directly.
- **TV audio queue (FR-TV-02):** announcement-level serialization is a
  **decorator** (`QueuedAudioProvider` in `tv-display-service/src/audio/`)
  over the fragment sequencer (`SequencerAudioProvider`), not a god-class.
  SRP split: the inner serializes fragments *within* one announcement; the
  decorator serializes whole announcements *between* calls. The decorator
  implements the same `AudioProvider` (`playSequence`/`stop`) interface, so it
  is a drop-in. **The drain single-flight guard is load-bearing:** in
  `drain()`, `if (this.running) return; this.running = true;` must run
  synchronously *before the first `await`* so a second `playSequence` arriving
  while the inner is mid-fragment only enqueues — never starts a second
  concurrent drain (which would reintroduce overlap). Do not reorder those two
  lines or push the assignment behind an `await`. The queue is **FIFO, not
  interrupt-on-new-call** — a half-announced ticket number is worse UX than a
  brief lag. `buildCallFragments` decomposes **both** the ticket number and the
  counter id digit-by-digit so every fragment maps to an existing
  `/tv/audio/<digit>.mp3` (NFR-REL-01 — there is no `10.mp3`); a single `'10'`
  counter fragment would be silently dropped by the sequencer's error-skip.
  `tv-store` calls `audio.stop()` on `SYSTEM_RESET` and on unmount to drain
  stale queued announcements. There is **no `domain/notification` bounded
  context in core-api** — audio is a pure client concern.
- **TV board history projection (FR-TV-01):** the `tv-store` `history`
  ("Riwayat Panggilan", up to 5) retains a ticket when it **concludes**, not
  merely when the next call displaces it. `projectEvent`'s `STATUS_UPDATED`
  case pushes the outgoing `nowServing` into `history` on a `COMPLETED`
  transition (then nulls it) — without this the common single-counter flow
  (call → serve → complete → call next) left history empty. `SKIPPED`
  (recallable via "Panggil Ulang") and `WAITING` (transfer, re-enters the
  queue) are deliberately **not** retained — neither is a concluded call. Do
  not "complete" history by pushing `SKIPPED` into it — `SKIPPED` is
  recallable, not concluded, so it stays out of history (a recalled ticket
  re-appears as `nowServing` via `TICKET_CALLED`, not via history restore). No
  double-push: the `aggregateId` guard skips a `STATUS_UPDATED` for a ticket
  no longer `nowServing`, and a `TICKET_CALLED` after a `COMPLETED` finds
  `nowServing` null so pushes nothing.
- **TV standby mode (FR-TV-03):** when the queue is idle (`nowServing == null`)
  the board shows a standby panel that cycles bundled local banner/video
  promo media plus a prominent running-text announcement, and crossfades back
  to the active now-serving board on the first `TICKET_CALLED`. tv-display
  only — standby media is a pure client concern (the backend never displays
  media), mirroring the audio precedent; the PRD §7 config schema carries no
  `runningText`/`media`/`standby` field, so manager-configurability is out of
  scope. Idle content is a client-owned default + bundled local assets
  (`public/media/`, precached by Workbox), exactly like the audio MP3s in
  `public/audio/`. **No speculative `StandbyMediaProvider` interface** — there
  is exactly one media renderer and a speculative port would be
  over-abstraction; the test seam is the `baseURL`/`assets` props.
  `src/standby/standby-content.ts` is the single source of truth for idle
  content; `StandbyMedia` cycles image (timer) / video (`ended`, single
  loops), error-skips missing assets, and holds once every asset has errored
  (no tight loop).

### Shared design-token system + a11y/interaction baseline (all 4 frontends)

The four standalone frontend services share a token + interaction baseline via
**generated vendored copies**, NOT a workspace package — there is no workspace
manager, no `packages/` dir, no root `tsconfig`, and each service is a
self-contained container (NFR-MNT-02). The canonical source of truth is
`shared/design-tokens/tokens.css` (OKLCH color space for perceptual uniformity)
+ `shared/design-tokens/interactions.css` (the a11y/interaction baseline).
`scripts/sync-design-tokens.mjs` copies each into every service's
`src/styles/_tokens.css` / `_interactions.css`; the leading `_` marks them
generated/do-not-edit. The copies are **committed** (not gitignored) so a
fresh clone builds each service standalone, and a **drift gate** in
`scripts/run-verify.mjs` re-runs sync then
`git diff --exit-code -- services/*/src/styles/_tokens.css
services/*/src/styles/_interactions.css` fails if a copy diverges — catches
both a forgotten re-sync after editing the source and a direct edit of a
generated copy. `tv-display-service` imports `_tokens.css` ONLY (no
`_interactions.css`) — the TV board is display-only; if a control is ever
added to the TV, add the interactions import then.

**General rule — for a shared frontend asset across the standalone services,
prefer generated vendored copies (canonical source + sync script + committed
copies + drift gate) over a workspace package; for a tiny runtime leaf (theme
injection), prefer 4× duplication over a shared/synced module.** Matches the
standalone-container ethos + NFR-MNT-02; the drift gate makes the 4× copies
machine-consistent.

Token conventions:
- `--accent` is kept **hex `#2563eb`** (not OKLCH) so a JS-injected
  hex/oklch `brandColor` overrides cleanly at runtime (the runtime-injection
  interop point); `--text-muted` is hex and unchanged (5.71:1 passes WCAG
  1.4.3); `--accent-contrast` is `#ffffff` with a **documented limitation** —
  a light manager-picked brandColor could fail contrast with white text, and
  there is no contrast algorithm in scope (a downstream remediation ticket
  owns that).
- Accent/danger **TEXT on the dark surface** uses the dedicated
  `--accent-on-dark` (`oklch(0.714 0.143 254.6)`, ~`#60a5fa`, 5.75:1) and
  `--danger-on-dark` (`oklch(0.711 0.166 22.2)`, ~`#f87171`, 6.45:1) tokens —
  swap only `color:` (text) usages to the `-on-dark` variants; leave
  `background:`/`fill:` usages of `--accent`/`--danger` intact (a fill is not
  text).
- The focus baseline uses `:where(...):focus-visible` for **zero
  specificity** so service overrides win; `.pressable` is the opt-in `:active`
  pressed-state utility for cards.

**Runtime `--accent` from `SystemConfiguration.brandColor`:** each service has
a `src/lib/theme.ts` leaf utility (`applyBrandColor(brandColor)` →
`document.documentElement.style.setProperty('--accent', ...)`, no-op on
empty/invalid so the CSS default wins). This `theme.ts` is **deliberately
duplicated 4× (one per service), NOT synced and NOT a shared package** — a
~10-line leaf duplicated 4× is less over-engineering than a shared/synced TS
module crossing the standalone-service boundary (minimal-dependency ethos,
same precedent as the audio-sequencer). The static `--accent:#2563eb` in
`_tokens.css` is the pre-fetch / fetch-failure fallback — it IS the default,
so there is no flash of the wrong accent before the brand-color fetch
resolves. Wiring rides existing boot fetches where they exist (kiosk widens
`StoreProfileSlice` → `{storeName, brandColor}` and applies in the existing
`Promise.allSettled` boot; tv applies in `tv-store.tsx` boot `.then` as a DOM
side effect — NOT in the reducer; caller adds a `BrandConfigSlice` +
`getBrandColor()` on `ICallerApi` (ISP slice — brandColor only) + a
top-level `useEffect` in `App.tsx`; admin reuses the existing `getSystemConfig()`
in a top-level `useEffect`).

### General

- When adding a feature, map it to the relevant FR-* / NFR-* requirement in
  the PRD and the bounded context it belongs to. Preserve the interface
  boundaries (e.g. don't leak admin DTOs into `ICallerApi`).
- Tests: include `InMemoryQueueRepository`-based unit tests for use cases;
  integration tests must run without internet.

### Acceptance suite

The DoD-1..5 acceptance specs live in
`services/core-api/test/acceptance/*.acceptance.spec.ts` (co-located in
core-api — not a separate project — to reuse its jest config + ts-jest +
`@core-api/*` aliases + direct `AppModule` imports). They run via
`npm run test:acceptance`.

- **Jest `testMatch` vs `testPathIgnorePatterns`:** to keep acceptance specs
  out of the default `npm test` unit gate, use `testMatch` **negation** in
  `jest.config.js` (`['**/*.spec.ts', '!**/*.acceptance.spec.ts']`), NOT
  `testPathIgnorePatterns`. The CLI `--testMatch` overrides config `testMatch`
  (replacing it entirely) but does **not** override `testPathIgnorePatterns` —
  so an ignore-pattern entry excluding `*.acceptance.spec.ts` also excludes
  them from the `test:acceptance` run, yielding "No tests found" exit 1.
- **DoD-4 (`power-cut-recovery`)** self-skips (`describe.skip`) when
  `QMS_ACCEPTANCE_DB_URL` is unset or `dist/main.js` is absent, so the gate
  stays green without a DB; CI sets the env var (and
  `scripts/run-acceptance.mjs` builds core-api first). It spawns `node
  dist/main.js` with `QMS_PERSISTENCE=postgres`, drives a ticket to `SERVING`,
  `SIGKILL`s it, respawns against the same DB, and asserts state + sequence
  recover exactly. Its `resetDb()` drops+recreates the `public` schema (not
  `TRUNCATE`, which fails on a cold DB with "relation does not exist").
- **Direct-repo acceptance variant:** an acceptance spec that exercises
  repos/tx-manager directly via ts-jest (no `node dist/main.js` spawn) gates
  on `QMS_ACCEPTANCE_DB_URL` only — NOT `dist/main.js` (it needs no build).
  `sequence-durability.acceptance.spec.ts` proves the atomic-upsert contract: N
  parallel `nextTicketNumber` → exactly 1..N (no dupe/gap), and a
  `runInTransaction` that reserves then throws rolls the increment back. Its
  `beforeAll` drops+recreates `public` then runs
  `PostgresMigrationRunner.onModuleInit()` for a pristine schema (the runner's
  `__dirname/migrations` resolves to `src/…/migrations` under ts-jest, no
  build needed).
- **Jest call-order assertions:** this repo's `@types/jest` does not expose
  `toHaveBeenCalledBefore` (TS2551 at compile). Assert mock call order with
  numeric `mock.invocationCallOrder[i]` comparisons instead.
- **Jest spy accumulation:** `jest.spyOn(obj, method)` on the same prototype
  across tests returns the *same* spy — call counts accumulate and are NOT
  reset by re-spying in `beforeEach` (the jest config has no
  `restoreMocks`). Add `afterEach(() => jest.restoreAllMocks())` whenever a
  spec asserts call counts.

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