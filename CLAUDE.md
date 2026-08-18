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
| tts-service tests | `.venv/bin/python -m pytest` (in `services/tts-service`) |
| tts-service dev server | `.venv/bin/uvicorn app.main:api --port 8000` (in `services/tts-service`) |
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
| `tv-display-service` | React | 3002 | `/tv` | TV queue board + announcement playback |
| `tts-service` | Python/FastAPI | 8000 | `/tts/*` | Offline Indonesian announcement synthesis (Piper TTS) |
| `caller-service` | React PWA | 3003 | `/caller` | Counter staff panel, dynamic action buttons |
| `admin-service` | React | 3004 | `/admin`, `/wizard` | Manager control panel, wizard, analytics, master data |
| `db-service` | PostgreSQL 15 / SQLite | 5432 | internal | Queue transactions, system config, audit trail |

**Clean Architecture (core-api):** Infrastructure (Express, Postgres, WS) →
Interface Adapters (Controllers, Presenters, Repos) → Application (use cases) →
Domain (entities, VOs, aggregates, events, ports). **NFR-MNT-01:** Domain has
**zero** deps on ORM/HTTP/IO (incl. Node built-ins `crypto|fs|net|http|https|
tls|child_process`). High-level modules depend on abstractions, never concrete
infrastructure (DIP).

**SOLID:** SRP — each UI service owns one concern (tv renders + *plays* audio;
`tts-service` decides what is said and how it sounds; kiosk owns printing only).
OCP — `TtsEngine` (tts-service) is the port that makes the model swappable
(Piper today, human recordings alongside it), and `AudioProvider` (tv) is an
interface for *playback*; `QueuedAudioProvider` decorates any `AudioProvider` to
serialize whole announcements FIFO (FR-TV-02). LSP —
`IQueueRepository` impls (Postgres + in-memory) must be interchangeable. ISP —
`caller-service` consumes only `ICallerApi`; never leak admin/reporting DTOs.
DIP — use cases & domain depend on interfaces, not the ORM/DB directly.

## Domain model (DDD bounded contexts)

Four bounded contexts: **Queue**, **Store Config**, **Reporting**, **Identity**.
(Announcement audio lives in `tts-service`, not core-api: core-api still never
plays or synthesizes sound and has no `domain/notification` context — a
server-side audio *model* would be over-abstraction. What core-api owns is the
*configuration*: `tts-service` reads the announcement settings from the public
`GET /api/system/config`, so the dependency points tts-service → core-api and
never back. A `TtsConfiguration` VO in the Store Config context — mirroring
`PrinterConfiguration`, with an admin page — is the planned follow-up; until it
lands the config client falls back to a working Piper default, and it also has
to, because a store configured by an older wizard will never carry the field.)

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
`action_label` → Caller UI button, plus a `TransitionAction` ∈
{`UPDATE_STATUS`, `TRANSFER_CATEGORY`} saying **what running it does**
(default `UPDATE_STATUS`, absent on pre-feature configs).

**Never infer an edge's meaning from its endpoints.** `X → WAITING` used to be
executed as a category move, so a manager who drew `CALLING → WAITING` to
re-queue a ticket got a "Pindah Kategori" button demanding a destination
category. The flow declares the next state AND the action; both sides read them.

**One per-ticket transition command.** `POST /api/queue/:id/transition
{ targetStatus, counterId? }` runs any edge the active flow allows, canonical or
custom, and `QueueTicket.applyTransition` applies the **target state's** side
effects (→CALLING announces at a counter, →SERVING/→COMPLETED stamp the
lifecycle clock, →WAITING clears the counter + resets the clock). There is no
serve/complete/skip/recall endpoint: a per-target surface forces something
upstream to guess which one an edge needs. `call-next` (counter-level ticket
*selection*) and `reannounce` (no state change, so it needs no
`CALLING → CALLING` edge) survive because neither is a per-ticket transition.

**Transfer Queue** ("pindah kategori", FR-CLR-03) keeps its own command because
it takes an argument no flow can hold — the destination category, chosen by
staff per ticket. `TransferTicketUseCase` validates `currentStatus →
targetStatus` against the active `ITransitionPolicy`, requires the edge to be
declared `TRANSFER_CATEGORY`, then reassigns category + reissues a per-category
number (clearing the counter). Both directions are enforced
(`application/queue/declared-transition-action.ts`) so an edge can never run as
the wrong command. Pre-checks before reserving the new number so an illegal
transfer burns no sequence (NFR-REL-02).

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
  imports — enforced by static analysis (acceptance criterion) in **both**
  languages: dep-cruiser for core-api, `tests/test_architecture.py` for
  tts-service. A new layered service without such a gate does not satisfy this.
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
- **tts-service:** Python 3.13 + FastAPI + Piper (`id_ID-news_tts-medium`).
  Clean Architecture mirroring core-api (`domain` pure — Indonesian number
  morphology + the announcement script; `application`; `infrastructure`;
  `interface_adapters`), enforced by `tests/test_architecture.py` — an `ast` walk
  that is this service's dep-cruiser (allowlist of pure stdlib per layer + ring
  order; `app/main.py` is the exempt composition root). Two `TtsEngine` impls ship
  together — `PiperTtsEngine` and `PrerecordedTtsEngine` (human word recordings
  from a folder **bind-mounted in `docker-compose.yml`**, without which the
  directory does not exist in the image and the second engine reports zero voices)
  — so swappability is demonstrated, not just claimed. ffmpeg does the bell,
  two-pass `loudnorm`, silence trim and MP3 encode; clips are cached by a digest of
  engine+voice+knobs+text in a named volume, **bounded** because
  `/tts/preview?text=` is unauthenticated free-form text — eviction is FIFO by
  write time, *not* LRU: refreshing mtime on a hit would put a write on the read
  path, and the cost (a preview flood evicts the hot set) is one re-synthesis, not
  corruption. Base image MUST stay Debian slim:
  `onnxruntime` publishes no musllinux wheel, so Alpine would try to compile ONNX
  Runtime from source. The voice is downloaded during `docker build` (build-time
  internet is already required by every service's `npm ci`) — runtime stays
  offline per NFR-REL-01.
- **Deployment:** `docker-compose.yml` + per-service Dockerfiles + nginx
  `gateway` with first-run `auth_request` guard. `gateway` `depends_on
  core-api-service` with `condition: service_healthy`, and `tts-service` with
  `condition: service_started` — **not** `service_healthy`, or a voice that fails
  to load would stop the gateway from ever starting and hang
  `docker compose up -d` (NFR-MNT-02). `/tts/` is exempt from the first-run
  guard like `/api/`: a 302 to wizard HTML is undecodable for an `<audio>`
  consumer.
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
`tts-service` is Python, so its equivalent is a one-time
`python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`; the
gate invokes `.venv/bin/python -m pytest` directly and fails with those exact
commands if the venv is missing. Its ffmpeg/Piper-dependent specs **skip**
(never fail) when ffmpeg or the 63 MB voice is absent, so the gate is green on a
fresh clone without any model download.

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
  direct path, not the barrel); every command drains events after `queue.save`;
  transfer emits 2 events, a `→ CALLING` transition emits 2 (TICKET_CALLED
  re-shows on TV) but the `CALLING → CALLING` self-loop emits only the
  announcement; the transition command accepts canonical targets and rejects only
  a `TRANSFER_CATEGORY` edge, which must itself target `WAITING`. → memory
  `core-api-architecture-gotchas`
- **Domain value-object rules** — construction failures throw
  `InvalidValueObjectException` (never bare `Error`); `InvalidArgumentException`
  for guardrails on a supplied argument — usually a use case, but an aggregate may
  raise it for a precondition on an argument rather than on its own state (a
  `→ CALLING` transition with no counter); declare module `const`s before a VO with a `static
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
  specificity — hover/selected and the drop-target reveal are (0,5,0) and beat
  the at-rest (0,4,0) rule by higher specificity, while `.connectingfrom` ties
  (0,4,0) and relies on source order; the `.connectable` gate on hover/selected
  exists to exclude read-only/default mode (no `connectable`), not to win a tie.
  → memory `frontend-conventions-gotchas`
- **TV board** — `QueuedAudioProvider` decorator over
  `RemoteAnnouncementAudioProvider` (drain single-flight guard is load-bearing,
  FIFO not interrupt; the inner MUST always settle its promise — an unsettled one
  wedges the loop with `running = true` and mutes the board until reload, which is
  exactly what a refused autoplay `play()` used to do since `NotAllowedError`
  fires neither `ended` nor `error`); one announcement = one clip URL from
  `tts-service`, so the TV holds no Indonesian grammar and no audio assets;
  `AudioUnlockable` is a **separate capability interface** + `isAudioUnlockable`
  guard, not part of `AudioProvider` (ISP — the store's `makeAudio()` fake is used
  30-plus times and never unlocks); history
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