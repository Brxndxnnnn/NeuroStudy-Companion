# NeuroStudy-Companion
SE_2: NeuroStudy Companion(EEG Focus Meter, Session Tracking and Insights)

## Backend

This repository includes a Dockerized PostgreSQL database and a Node.js backend so the API can be run without installing PostgreSQL or Node.js locally. This is the recommended path for anyone who just wants to use the backend service from another client, such as the frontend.

## How Docker Networking Works Here (Read This First)

Understanding this prevents the most common setup mistake.

When services run **inside Docker**, they communicate using Docker's internal DNS — each service is reachable by its **service name** as the hostname (e.g. `db`, `backend`). The port used is the container's **internal** port.

When a service runs **outside Docker** (e.g. `npm run dev` on your machine), it cannot use Docker's internal DNS. Instead, it reaches the DB through the **host machine** using `localhost` and the **exposed** port.

This is why two separate environment files exist:

| Context | `POSTGRES_HOST` | `POSTGRES_PORT` | Why |
|---|---|---|---|
| Inside Docker (`docker compose up backend`) | `db` | `5432` | Docker internal DNS, container's native port |
| Outside Docker (`npm run dev`) | `localhost` | `5433` | Host machine, exposed port mapping from `compose.yaml` |

The `5433` port only exists on your host machine as the entry point into the DB container. Inside Docker, everything still runs on `5432`.

## Environment Files

Two environment files control which context your backend runs in:

| File | Used by | `POSTGRES_HOST` | `POSTGRES_PORT` |
|---|---|---|---|
| `.env.docker` | `docker compose` (via `env_file` in `compose.yaml`) | `db` | `5432` |
| `.env` | `npm run dev` (local Node.js process) and your other local services eventually | `localhost` | `5433` |

***
### 1. Copy `.env.example` to create both files if missing:

```bash
cp .env.example .env
cp .env.example .env.docker
```

### 2. Edit `.env.docker` for Dockerized backend — use Docker internal addresses:

```env
NODE_PORT=3000
POSTGRES_DB=neurostudy
POSTGRES_USER=your_own_username
POSTGRES_PASSWORD=your_own_password
POSTGRES_HOST=db
POSTGRES_PORT=5432
```

### 3. Edit `.env` for local development.

```env
NODE_PORT=5000
POSTGRES_DB=neurostudy
POSTGRES_USER=your_own_username
POSTGRES_PASSWORD=your_own_password
POSTGRES_HOST=localhost
POSTGRES_PORT=5433
```

Notes:

- `docker compose` reads the file referenced by `env_file` in [compose.yaml](compose.yaml) — by default this repository uses `./.env.docker` for the `backend` service.
- Do not commit secrets (like real production `JWT_SECRET`) to the repository.
- To generate a strong `JWT_SECRET` you can run (Node):

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

or in PowerShell:

```powershell
[Convert]::ToBase64String((1..64 | ForEach-Object { Get-Random -Maximum 256 }))
```

***

## Option A — Fully Dockerized

Runs both the database and backend inside Docker. No Node.js or PostgreSQL installation required.

```bash
docker compose up --build db backend
```

This starts:

- `db` (TimescaleDB) — accessible at `localhost:5433` from your host machine
- `backend` (Node.js/Express) — accessible at `localhost:3000`

The backend waits for the database health check before starting. The schema is automatically applied from `db/migrations/001_init.sql` on first start.

**Verify the backend is running:**

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok",
  "db_time": "..."
}
```

If you are connecting a frontend or another service, point it at `http://localhost:3000`.

***

## Option B — Dockerized DB, Local Backend

Runs only the database in Docker. The Node.js backend runs directly on your machine. Use this for active backend development with faster iteration.

**Step 1 — Start only the database:**

```bash
docker compose up db
```

**Step 2 — Run the backend locally:**

```bash
cd backend
npm install
npm run dev
```

The backend reads `.env` (not `.env.docker`) when run this way. Make sure `.env` has `POSTGRES_HOST=localhost` and `POSTGRES_PORT=5433`.

**Why `localhost:5433` and not `localhost:5432`?**

Your machine may have a local PostgreSQL installation already running on port `5432`. The Docker DB container is exposed on `5433` to avoid a collision. If you accidentally connect to `5432`, you will hit your local PostgreSQL instance (which has no `neurostudy` database) and see a `database does not exist` error.

***

## If You Are Building Another Service (ML, C#, etc.)

The same networking rules apply to any service that needs to talk to the database or backend:

- **Inside Docker** → use `db:5432` for the database, `backend:3000` for the backend API
- **Outside Docker** → use `localhost:5433` for the database, `localhost:3000` for the backend API

When your service is ready to be added to Docker Compose, add it to `compose.yaml` and point it at `db:5432`. The commented-out `neuuro_bridge` section in `compose.yaml` shows the expected structure.

### Useful Commands

| Action | Command |
|---|---|
| Start DB and backend | `docker compose up --build db backend` |
| Start DB only | `docker compose up db` |
| Stop all services | `docker compose down` |
| Stop and wipe DB volume (full reset) | `docker compose down -v` |
| View backend logs | `docker compose logs -f backend` |
| View DB logs | `docker compose logs -f db` |
| Connect to DB via psql | `psql -h localhost -p 5433 -U neurostudy_user -d neurostudy` |

### Optional local development

If you do have Node.js installed and want to run the backend outside Docker for faster iteration:

```bash
cd backend
npm install
npm run dev
```

For local development, keep [backend/.env](backend/.env) pointed at the Dockerized Postgres instance by using the equivalent `POSTGRES_*` variables, or update those `POSTGRES_*` values to match your own Postgres setup.
