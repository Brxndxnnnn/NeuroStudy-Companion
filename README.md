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
│  activation dialog ──────┼──HTTPS───────▶│   │     └ /api/ml/ → ml_service (int.) │
│                          │  /api/clinics/│   └── /bridge-updates/ → Velopack feed │
│  EEG + band powers ──────┼──TLS 5432────▶│  db ── TimescaleDB (Postgres 17)       │
│  (binary COPY, direct)   │               │  ml ── FastAPI, NOT internet-exposed   │
│                          │               │  certbot ── Let's Encrypt renewals     │
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
3. **Session lifecycle:** ownership is split, and each side sets only the transitions it
   can vouch for. The **bridge** creates the row (`unclaimed`, with a pairing code) when
   the headset connects → the **web** claims it by pairing code → the **web** flips
   `sync_status='recording'` and the bridge auto-starts uploading → images and events are
   recorded by the web → on Stop the **bridge** drains, flushes, and only then writes
   `completed`. That ordering is the guarantee that every EEG row has landed before the ML
   service touches the session. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
`/api/` backend + `/api-docs` Swagger). `ml_service` is deliberately not routed by
nginx — reach it through the authenticated backend at `/api/ml/...`, or hit the
container directly during development (`docker compose exec ml ...`). Only the DB is
reachable directly (`localhost:5433`, psql:
`psql -h localhost -p 5433 -U $POSTGRES_USER -d neurostudy`).

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

Go to the **Actions** tab, pick **"Deploy to production"**, and **Run workflow** against
`main`. Merging to `main` does *not* auto-deploy — the manual trigger is the approval
gate. For a rollback, run the same workflow against an earlier `v*` tag.

The workflow applies migrations before starting the app code, rebuilds images, restarts
nginx, health-checks five routes, and tags the release. Defined in
[`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml);
step-by-step breakdown in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#9-build-deploy-release).

Manual fallback, only if Actions is unavailable or you're debugging a failed run:

```bash
ssh root@139.59.126.77
cd /opt/NeuroStudy-Companion
git fetch origin && git reset --hard origin/main     # NOT `git pull`

docker compose -f compose.yaml -f compose.prod.yaml up -d --wait db
COMPOSE_FILES="-f compose.yaml -f compose.prod.yaml" ./db/migrate.sh
docker compose -f compose.yaml -f compose.prod.yaml up -d --build
docker compose -f compose.yaml -f compose.prod.yaml restart nginx
```

`--build` is not optional: `frontend` is a built image with no bind mount, so without it
a frontend change silently does not deploy.

**Never edit tracked files on the droplet** — anything that must survive a deploy has to
be in git. `.env.docker` secrets and `/var/bridge-updates` live outside git by design.

DB migrations (`db/migrations/*.sql`) are tracked in a `schema_migrations` table and
applied forward-only by `db/migrate.sh`. For local dev, run `./db/migrate.sh` by hand
after pulling new migration files.

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

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the single system reference.** Session
lifecycle, data model, service boundaries, the ML Phase 1 pipeline, security model,
deploy pipeline, and the known open issues. Every claim cites the code that implements
it.

It is deliberately the *only* design document. Seven earlier docs — four of them plans
written before the code existed — were deleted on 24 Jul 2026 because they described
superseded designs and were being quoted as current. **Please don't add a second one:
extend `ARCHITECTURE.md` and cite the file you changed.**
