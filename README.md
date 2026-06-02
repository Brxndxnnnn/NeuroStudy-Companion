# NeuroStudy-Companion
SE_2: NeuroStudy Companion(EEG Focus Meter, Session Tracking and Insights)

## Backend

This repository includes a Dockerized PostgreSQL database and a Node.js backend so the API can be run without installing PostgreSQL or Node.js locally. This is the recommended path for anyone who just wants to use the backend service from another client, such as the frontend.

### What to edit

Before starting the services, make sure the backend environment file is in place and matches the Docker Compose settings.

### Environment files (.env vs .env.docker)

We use two environment files to separate containerized settings from running the backend locally:

- `.env.docker` — used by `docker compose` via the `env_file` entry in [compose.yaml](compose.yaml). This file should contain values appropriate for the containers (for example `POSTGRES_HOST` set to `db` and `POSTGRES_PORT` set to `5432`).
- `.env` — used when running the backend locally (for example with `npm run dev`). This file can contain developer-specific overrides (local hostnames, credentials, or tools) and is not required to be identical to `.env.docker`. An example would be `POSTGRES_HOST` set to `localhost` and `POSTGRES_PORT` set to `5433`.

Recommended workflow:

1. Copy `.env.example` to create both files if missing:

```bash
cp .env.example .env
cp .env.example .env.docker
```

2. Edit `.env.docker` so the `POSTGRES_*` values point to the Dockerized DB (example):

```env
POSTGRES_DB=neurostudy
POSTGRES_USER=your_own_username
POSTGRES_PASSWORD=your_own_password
POSTGRES_HOST=db
POSTGRES_PORT=5432
```

3. Edit `.env` for local development if you intend to directly connect to the Dockerized database without Dockerizing your service. Keep the `POSTGRES_*` values pointed at the Dockerized DB unless you intentionally want to connect to a different Postgres instance.

```env
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

### Run the database and backend with Docker

From the repository root, run:

```bash
docker compose up --build db backend
```

This starts:

1. `db` on `localhost:5433`
2. `backend` on `localhost:3000`

The backend waits for the database health check before starting. The initial database schema is loaded from [db/migrations/001_init.sql](db/migrations/001_init.sql).

### Verify the backend

Once the containers are running, you can confirm the API is available with:

```bash
curl http://localhost:3000/health
```

Expected response shape:

```json
{
	"status": "ok",
	"db_time": "..."
}
```

If you are wiring up the frontend, point it at `http://localhost:3000` for API requests.

### Useful commands

Stop the services:

```bash
docker compose down
```

Stop the services and remove the database volume:

```bash
docker compose down -v
```

View logs:

```bash
docker compose logs -f backend
docker compose logs -f db
```

### Optional local development

If you do have Node.js installed and want to run the backend outside Docker for faster iteration:

```bash
cd backend
npm install
npm run dev
```

For local development, keep [backend/.env](backend/.env) pointed at the Dockerized Postgres instance by using the equivalent `POSTGRES_*` variables, or update those `POSTGRES_*` values to match your own Postgres setup.
