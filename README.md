# NeuroStudy Companion

EEG study/therapy companion for QIROM Consulting: a clinician runs an image-based
session in the web app while the client wears a **Neeuro SenzeBand** headset; a
Windows bridge streams the EEG straight into the database in real time, and the
platform produces session insights (focus/relaxation metrics, frequency-band
analysis, and an ML model that learns emotional-response predictions from
OASIS-labelled images).

**Production:** https://clinics.axonview.sg (droplet `139.59.126.77`)

---

## Architecture

```
 CLINIC MACHINE (Windows)                    DROPLET (Docker Compose)
┌──────────────────────────┐               ┌────────────────────────────────────────┐
│  NeuuroBridge (C# WPF)   │               │  nginx ── TLS, routing, update feed    │
│  SenzeBand ──BLE──▶ app  │               │   ├── /            → frontend (Next.js)│
│                          │   one-time    │   ├── /api/        → backend (Express) │
│  activation dialog ──────┼──HTTPS───────▶│   ├── /ml/         → ml_service (FastAPI)
│                          │  /api/clinics/│   └── /bridge-updates/ → Velopack feed │
│  EEG + band powers ──────┼──TLS 5432────▶│  db ── TimescaleDB (Postgres 17)       │
│  (binary COPY, direct)   │               │  certbot ── Let's Encrypt renewals     │
└──────────────────────────┘               └────────────────────────────────────────┘
```

| Component | Tech | Role |
|---|---|---|
| `frontend/` | Next.js | Clinician web app: clients, session flow (images/questions), results, admin, ML insights |
| `backend/` | Node.js / Express | REST API **for the frontend only** (JWT auth, per-request RLS tenant context). Single exception: the public `POST /api/clinics/activate` enrollment endpoint for the bridge |
| `ml_service/` | Python / FastAPI | Post-session feature workers (elliptic band stats + our own FFT/Welch band powers), ML Phase 1 (EEG → OASIS valence/arousal): weekly training cron, model registry, inference |
| `neuuro_bridge/` | C# WPF (.NET Framework 4.8, x64) | Windows app at the clinic. Connects the SenzeBand over BLE and writes EEG **directly to the DB** via binary COPY — the backend is never in the data path |
| `db/` | TimescaleDB | Hypertables `eeg_raw_samples`, `eeg_filtered_samples`, `eeg_readings`, `band_powers`; forced row-level security for clinic tenancy; migrations in `db/migrations/` |
| `nginx/` + certbot | nginx | TLS termination, service routing, and the static Velopack update feed at `/bridge-updates/` |

**Data-flow rules (load-bearing, don't break them):**

1. **The bridge writes directly to the database.** No backend hop, no polling in the
   write path. A DB hiccup never blocks streaming — rows queue and flush on a timer.
2. **The backend serves the frontend only.** The one sanctioned exception is one-time
   bridge **enrollment** (activation); after that the bridge never talks to it again.
3. **Session lifecycle:** the bridge creates the session row (`unclaimed`, with a
   pairing code) when the headset connects → the web claims it by pairing code →
   recording auto-starts when the web flips `sync_status='recording'` → images and
   events are recorded by the web → Stop flips the session to `completed`, after which
   the ML service's feature jobs run. Details: [docs/session-data-flow.md](docs/session-data-flow.md).

---

## Installing the bridge at a clinic

No config files, no credentials to type — install, enter an activation code, done.

1. **Requirements:** Windows 10 (1903+)/11 64-bit, Bluetooth LE, internet access.
2. Download and run
   [`NeuuroBridge-win-Setup.exe`](https://clinics.axonview.sg/bridge-updates/NeuuroBridge-win-Setup.exe).
   Windows will show "Windows protected your PC" (the app is not yet code-signed):
   click **More info → Run anyway**. This happens once.
3. The app starts and asks for an **activation code** (format `XXXX-XXXX-XXXX-XXXX`,
   issued per clinic by the administrator). Activation fetches the clinic's database
   credentials and license key from the server and stores them encrypted (Windows
   DPAPI) in `%ProgramData%\NeuuroBridge\` — they survive every update.
4. **Updates are automatic:** on launch the app checks the update feed and asks
   before installing. Activation is never repeated.

Codes are single-use; to re-activate a machine (credential rotation, replacement PC),
delete `%ProgramData%\NeuuroBridge\bridge.env`, relaunch, and enter a fresh code.
Daily-use and troubleshooting notes for clinic staff:
[neuuro_bridge/packaging/CLINIC-README.txt](neuuro_bridge/packaging/CLINIC-README.txt).

---

## Development setup

Prerequisites: Docker Desktop; Node.js (frontend/backend dev loops); Python 3.11+
(ml_service dev); .NET SDK (builds the net48 bridge solution).

### 1. Environment files

Copy the root `.env.example` into each service, twice — `.env` for processes running
**on your machine**, `.env.docker` for the **containerized** context:

```bash
cp .env.example backend/.env       # POSTGRES_HOST=localhost, POSTGRES_PORT=5433
cp .env.example backend/.env.docker  # POSTGRES_HOST=db,        POSTGRES_PORT=5432
cp .env.example db/.env.docker
# same pattern for frontend/, ml_service/, neuuro_bridge/ as needed
```

Why two: inside Docker, services resolve each other by service name (`db:5432`);
from your host you reach the DB through the published port (`localhost:5433` — 5433
so it can't collide with a locally installed Postgres). All env files are gitignored.

For the **bridge** dev `.env` (`neuuro_bridge/.env`), see
[neuuro_bridge/NeuuroBridge/.env.example](neuuro_bridge/NeuuroBridge/.env.example):
it needs `NEUURO_LICENSE_KEY` plus the `POSTGRES_*` values, and
`ACTIVATION_OPTIONAL=true` so dev runs skip the first-run activation dialog.

### 2. Run the stack

```bash
docker compose up --build          # db + backend + frontend + ml + nginx
```

Everything is fronted by nginx at **http://localhost:8090** (`/` frontend,
`/api/` backend + `/api-docs` Swagger, `/ml/` ml_service). Only the DB is reachable
directly (`localhost:5433`, psql: `psql -h localhost -p 5433 -U neurostudy_user -d neurostudy`).

For faster iteration run the DB in Docker and the service you're working on locally:

```bash
docker compose up db
cd backend && npm install && npm run dev      # or: cd frontend && npm run dev
```

### 3. Bridge development (Windows)

```powershell
dotnet build neuuro_bridge\NeuuroBridge.sln -c Release   # Core + console + WPF, x64
```

Run `NeuuroBridge.Wpf` from `bin\` — with `ACTIVATION_OPTIONAL=true` in the repo
`.env` it uses your dev DB directly, exactly as before packaging existed. Real
SenzeBand hardware (BLE + online license auth) is required for actual streaming.
To exercise the activation flow without the real backend:
`python neuuro_bridge/tools/mock_activation_server.py` and set
`ACTIVATION_URL=http://localhost:8765/api/clinics/activate` (valid code
`TEST-C0DE-0001-MOCK`).

| Useful commands | |
|---|---|
| Stop all services | `docker compose down` |
| Full DB reset (wipes volume) | `docker compose down -v` |
| Tail a service log | `docker compose logs -f backend` |

---

## Releasing a bridge update

**Always bump the version first.** Velopack decides whether to offer an update by
comparing **version numbers**, not by whether files changed. Edit
`<Version>` in
[`neuuro_bridge/NeuuroBridge.Wpf/NeuuroBridge.Wpf.csproj`](neuuro_bridge/NeuuroBridge.Wpf/NeuuroBridge.Wpf.csproj)
and raise it (e.g. `1.0.2` → `1.0.3`) for **every** release. A release that reuses an
existing version reaches no client, and code changed without a bump is silently never
delivered.

### Option A — GitHub Actions (recommended)

With the version bumped and merged, go to the repo's **Actions** tab, pick
**"Deploy bridge update"**, and **Run workflow**. It packs the bridge against the
current feed (so deltas build) and publishes the release set to the droplet, the same
way the web services deploy. The workflow **refuses to publish a version that is
already on the feed**, so a forgotten bump fails there instead of shipping nothing.
Defined in [`.github/workflows/deploy-bridge.yml`](.github/workflows/deploy-bridge.yml);
it reuses the same `DROPLET_HOST` / `DROPLET_USER` / `DROPLET_SSH_KEY` secrets as the
production deploy.

### Option B — manual scripts (fallback)

One-time: `dotnet tool install -g vpk`. Then, with the version bumped:

```powershell
powershell -ExecutionPolicy Bypass -File neuuro_bridge\packaging\pack.ps1     # build + vpk pack
powershell -ExecutionPolicy Bypass -File neuuro_bridge\packaging\publish.ps1  # scp to the droplet feed
```

Installed bridges offer the update on next launch (delta downloads, config survives).
Roll a bad release **forward** (publish a higher version), never delete from the feed.
Packing against a fresh clone? Pull the current release set first so deltas build:
`vpk download http --url https://clinics.axonview.sg/bridge-updates/ -o neuuro_bridge\packaging\releases`.
A no-server local test of the full install → activate → update loop:
[neuuro_bridge/packaging/LOCAL-TEST.md](neuuro_bridge/packaging/LOCAL-TEST.md).

---

## Deploying the web stack

Deploys are a `git reset --hard` on the droplet plus a compose up — see
[docs/deploy.md](docs/deploy.md) for the full procedure and its rules (never edit
tracked files on the droplet; `.env.docker` secrets and `/var/bridge-updates` live
outside git and survive deploys).

```bash
ssh root@139.59.126.77
cd /opt/NeuroStudy-Companion
git fetch origin && git reset --hard origin/main
docker compose -f compose.yaml -f compose.prod.yaml up -d
```

DB migrations (`db/migrations/*.sql`) are tracked in a `schema_migrations` table and applied automatically by `db/migrate.sh` as part of the deploy pipeline — see `docs/deploy.md`. For local dev, run `./db/migrate.sh` by hand after pulling new migration files.

---

## Security model (summary)

- **Multi-tenancy:** forced Postgres row-level security on tenant tables; the backend
  sets `app.current_clinic_id` / `app.is_admin` per request from the JWT; clinic DB
  roles are constrained by policy to their own clinic's rows.
- **Bridge DB access:** each clinic gets its own login role inheriting `bridge_writer`
  — INSERT on the four streaming tables, INSERT/SELECT on `sessions`, column-level
  UPDATE on `sessions(bridge_recording_at, sync_status)`, and nothing else. Sessions
  are created via the `create_clinic_session()` SECURITY DEFINER function, which
  stamps the role's clinic. Connections use TLS with full certificate verification.
- **Enrollment:** activation codes are single-use, hashed + peppered server-side, and
  exchanged over HTTPS for per-clinic credentials, stored DPAPI-encrypted on the
  clinic machine. The endpoint is public by necessity (the code *is* the credential)
  and rate-limitable.
- **Installer:** currently unsigned (SmartScreen warning at install); an Authenticode
  cert is a planned, purely additive step.

---

## Further documentation

| Doc | What it covers |
|---|---|
| [docs/session-data-flow.md](docs/session-data-flow.md) | Session lifecycle, events timeline, clock sync, bridge/web ownership contract |
| [docs/bridge-packaging-plan.md](docs/bridge-packaging-plan.md) | Installer/auto-update/activation design and its decision history |
| [docs/deploy.md](docs/deploy.md) | Droplet deployment procedure and rules |
| [docs/feature-jobs-and-image-sets.md](docs/feature-jobs-and-image-sets.md) | Post-session feature jobs, image sets |
| [docs/ml-phase1-plan.md](docs/ml-phase1-plan.md) | ML Phase 1: training, promotion gating, inference, insights |
| [docs/frontend-db-contract.md](docs/frontend-db-contract.md) | What the frontend reads/writes vs what the bridge owns |
