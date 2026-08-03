# Queue Flow — Enterprise Offline Queue Management System (QMS)

An **offline, on-premise queue management system** for a single branch/store.
It runs 100% on a local LAN — **no internet, no cloud, no external CDN/API calls
at runtime**. Visitors take tickets at a kiosk, staff call them from a counter
panel, and a TV display shows the now-serving number with sequential audio
announcements. A manager administers categories, counters, the queue state
machine, and the daily-reset policy via an admin panel + first-run setup
wizard.

> Source of truth: the Linear PRD under the **Queue System** team (key `QUE`),
> project "Enterprise Offline Queue Management System (QMS)".

---

## Architecture

Single-host deployment: every service is a Docker container on **one** local PC
server, fronted by an NGINX reverse proxy (`gateway`, port 80). The whole stack
comes up with one command — `docker compose up -d`.

### Services

| Service | Stack | Internal port | External endpoint | Responsibility |
|---|---|---|---|---|
| `gateway` | NGINX Alpine | 80 | `http://antrian.local/` | Reverse proxy, static assets, first-run wizard routing |
| `core-api-service` | NestJS + TypeScript (Node.js) | 3000 | `/api/*`, `/ws` | Business logic, state machine, dynamic routing engine, WebSocket server, DB persistence |
| `kiosk-service` | React + Vite PWA | 3001 | `/kiosk` | Visitor touchscreen ticket UI + silent thermal printing |
| `tv-display-service` | React + HTML5 Audio API | 3002 | `/tv` | TV queue board + offline audio synthesizer |
| `caller-service` | React + Vite PWA | 3003 | `/caller` | Counter staff panel, dynamic action buttons from state machine |
| `admin-service` | React + Vite PWA | 3004 | `/admin`, `/wizard` | Manager control panel, setup wizard, analytics, master data |
| `db-service` | PostgreSQL 15 (WAL) | 5432 | internal only | Queue transactions, system config, audit trail |

### Architecture Diagram

```
                        ┌─────────────────────────────────────────────────┐
                        │              Local LAN (store network)           │
                        │            http://antrian.local/                │
                        └───────────────────────┬─────────────────────────┘
                                                │  :80
                                 ┌──────────────▼──────────────┐
                                 │          gateway            │
                                 │   (NGINX reverse proxy)    │
                                 │   • first-run guard        │
                                 │   • SSL termination        │
                                 └──────┬───────┬──────┬───────┬──────┬───────┘
                          /api,/ws │   /kiosk│  /tv │/caller│/admin│
                         ┌──────────▼──┐ ┌─────▼─┐ ┌──▼───┐ ┌──▼───┐ ┌──▼─────┐
                         │ core-api    │ │ kiosk │ │ tv   │ │caller│ │ admin  │
                         │  NestJS     │ │  PWA  │ │ PWA  │ │ PWA  │ │  PWA + │
                         │  port 3000  │ │ port  │ │port  │ │port  │ │ wizard │
                         └──────┬──────┘ │ 3001  │ │3002  │ │3003  │ │ 3004   │
                                │        └───────┘ └──────┘ └──────┘ └────────┘
                                │  TCP 5432 (internal only)
                         ┌──────▼──────────────┐
                         │     db-service      │
                         │  PostgreSQL 15 WAL  │
                         │  tickets · config   │
                         │  audit · archive    │
                         └─────────────────────┘

   Realtime:  caller ──(POST /api/queue/*)──▶ core-api ──(WebSocket /ws)──▶ tv
```

### Clean Architecture (in `core-api-service`)

Layers, outside-in: **Infrastructure** (Express, Postgres, WS) →
**Interface Adapters** (Controllers, Presenters, Repositories) →
**Application / Use Cases** (`CreateTicketUseCase`, `CallNextTicketUseCase`,
`ResetDailyQueueUseCase`) → **Domain** (Entities, Value Objects, Aggregates,
Domain Events).

The **Domain** layer has **zero** dependencies on ORM, HTTP framework, or I/O
libraries — enforced by [dependency-cruiser][dc] (`npm run arch:check` from
`services/core-api`). High-level modules depend on abstractions (interfaces),
never concrete infrastructure.

Three bounded contexts:
- **Queue** — `QueueTicket` aggregate (state machine `WAITING → CALLING →
  SERVING → COMPLETED`, plus `SKIPPED`; custom states configurable).
- **Store Config** — `SystemConfiguration` aggregate (state machine,
  daily-reset policy) and `CounterRoutingRule` aggregate (category routing +
  priority policy).
- **Notification** — handled entirely in `tv-display-service` (the backend
  never plays sound); audio is a pure client concern.

[dc]: https://github.com/sverweij/dependency-cruiser

---

## Deploy

### Prerequisites

- A single host PC server on the store LAN.
- **Docker** + **Docker Compose** installed on that host (the only runtime
  dependency — no internet is required at runtime).

### Bring the stack up

```bash
docker compose up -d --build
```

This builds every service image and starts all seven containers with
`restart: always` (self-healing). The `gateway` waits for `core-api-service`'s
healthcheck (`GET /api/health`) to pass before it starts serving, so the first
~1–2 s Nest bootstrap is covered — no 502s on a cold boot.

Then open a browser on the LAN at `http://antrian.local/` (or the server's IP).

### First-run setup

A clean store has no configuration yet. While `isInitialSetupCompleted == false`,
the gateway redirects **all** HTTP access to the first-run wizard at
`/admin/wizard` (the PRD is strict here — "semua akses HTTP"). Complete the
wizard's 5 steps:

1. **Profil Toko & Kategori** — store name, active counter count, categories.
2. **Routing matrix** — assign categories + priority per counter.
3. **State machine** — pick the PRD §7 default or build a custom one.
4. **Daily reset** — manual or automatic (cron), with archive toggle.
5. **Review** — confirm and `Simpan & Aktifkan`.

After setup completes the operational routes (`/kiosk`, `/tv`, `/caller`) load
normally and the system is live. The wizard stays available (re-editable) at
`/admin` post-setup.

### Useful commands

| Command | Purpose |
|---|---|
| `docker compose up -d --build` | Build + start the whole stack (also `npm run compose:up`) |
| `docker compose down` | Stop the stack (also `npm run compose:down`) |
| `docker compose logs -f core-api-service` | Tail backend logs |
| `npm run compose:verify` | Tier-1/2 topology smoke test through the gateway |
| `npm run verify` | Per-service unit + build gate (no Docker dependency) |
| `npm run acceptance` | DoD acceptance suite (`QMS_PERSISTENCE=postgres`) |

### Persistence profile

The compose stack runs the **PostgreSQL** profile (`QMS_PERSISTENCE=postgres`,
WAL-durable, `fsync=on` verified at boot) so ticket numbers and transaction
state survive a power cut with no duplicates or gaps (NFR-REL-02). The
in-memory profile remains the dev/test default for per-service unit tests
(`QMS_PERSISTENCE` unset).

### Hard constraints (enforced)

- **No internet at runtime (NFR-REL-01)** — every asset (JS, CSS, fonts, audio
  MP3s, DB drivers) is served from the local PC server. No external CDN link or
  remote API call in runtime code.
- **Power-loss resilient (NFR-REL-02)** — PostgreSQL + WAL; after an
  unexpected power cut, ticket numbers and transaction state recover exactly.
- **Container self-healing (NFR-REL-03)** — every service uses
  `restart: always`.
- **Local network only (NFR-SEC-01)** — app access is restricted to the store
  LAN subnet; `db-service` is not published externally.
- **Audit trail (NFR-SEC-02)** — manual reset, state-schema changes, routing
  changes, and transaction-log cleanup are written to the local audit log.

---

## Repository layout

```
queue-flow/
├── docker-compose.yml          # single-host deployment (7 services)
├── gateway/nginx.conf          # reverse proxy + first-run guard
├── services/
│   ├── core-api/                # NestJS backend (domain + use cases + REST/WS)
│   ├── kiosk-service/          # visitor touchscreen PWA
│   ├── tv-display-service/      # TV queue board + audio sequencer PWA
│   ├── caller-service/          # counter staff PWA
│   └── admin-service/          # manager panel + first-run wizard PWA
└── scripts/                     # verify / acceptance / topology gates
```

Each service owns its own `package.json` and install (the root is scripts-only,
no workspaces). See `CLAUDE.md` for the full development conventions.