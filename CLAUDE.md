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
  layer are merged (QUE-8, PR #1); QUE-12 added the local WebSocket broadcaster.
  Other services are not yet scaffolded.
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
  `ICounterRoutingRuleRepository`, `ITransitionPolicy` — never infrastructure
  concretions. It returns a transport-agnostic **DTO** (discriminated-union
  result), never the aggregate itself, so the interface-adapter layer maps it
  to HTTP/WS. Command + result DTOs are co-located with the use case. The
  active `StateMachine` (from `SystemConfiguration`) is supplied to the use
  case as an `ITransitionPolicy` by the interface-adapter/DI layer, not loaded
  by the use case.
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
- Frontends are React-family; `caller-service` is a PWA. Keep them offline-capable.
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