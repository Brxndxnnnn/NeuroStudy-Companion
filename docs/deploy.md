# Deploying to the droplet

**Normal path**: use the GitHub Actions workflow instead of the manual steps below.
Actions tab -> "Deploy to production" -> "Run workflow", branch `main` (or a `v*` tag
to roll back to a previous release). It SSHes in, rebuilds, restarts nginx, and runs
health checks automatically. Deploys never happen automatically on merge — this has to
be triggered by hand every time, on purpose.

The manual steps below are what that workflow does under the hood — useful if Actions
itself is unavailable, or you're debugging a failed run.

The droplet is `139.59.126.77`. The repo lives at `/opt/NeuroStudy-Companion` and the
whole stack runs from Docker Compose. Anyone with an authorised SSH key can deploy —
this does not need to go through one person.

```bash
ssh root@139.59.126.77
cd /opt/NeuroStudy-Companion

git fetch origin
git reset --hard origin/main          # NOT `git pull` — see below

docker compose -f compose.yaml -f compose.prod.yaml up -d
docker compose logs -f ml             # or backend / nginx
```

## Why `reset --hard` and not `pull`

`main`'s history was rewritten on 15 Jul (commit messages only — file content was
verified byte-identical). A branch whose history has been rewritten cannot fast-forward,
so `git pull` will refuse or try to merge two versions of the same commits. `reset --hard`
is the correct move, and is safe **because nothing that matters lives only on the droplet
any more** — see below.

## What used to make this dangerous

Until 15 Jul, three tracked files were edited directly on the droplet and never committed:

| file | droplet-only change |
|---|---|
| `compose.yaml` | Postgres bound to `127.0.0.1` instead of `0.0.0.0`; nginx on `:80` |
| `nginx/nginx.conf` | `server_name`, and `proxy_hide_header` so Swagger UI renders |
| `.env.example` | a trailing newline |

`git reset --hard` reverts uncommitted changes. So every deploy silently undid all
three — and the first one **published the production database to the internet**, with
nothing on screen to say it had happened.

All of it is now in git:

* the loopback DB binding is in `compose.yaml` (it is right everywhere, not just in prod)
* the public `:80` binding is in `compose.prod.yaml`
* the nginx changes are in `nginx/nginx.conf`

**If you ever need to edit a tracked file directly on the droplet, put it in
`compose.prod.yaml` (or the relevant committed file) instead.** Anything that must
survive a deploy has to be in git; the droplet's working tree is not storage.

## What is NOT in git, and shouldn't be

The `.env.docker` files hold real secrets and are gitignored. They live on the droplet
only. `git reset --hard` does not touch them (untracked files are left alone), so they
survive a deploy.

`/var/bridge-updates` (droplet host, outside the repo) holds the Windows bridge's
Velopack release files, served by nginx as `/bridge-updates/`. It is populated from a
dev machine via `neuuro_bridge/packaging/publish.ps1`, not by deploys — a deploy's
`git reset --hard` never touches it, and it must never be moved into the repo tree.

## Rebuilds

`ml_service` and `backend` are **bind-mounted** (`./ml_service:/app`, `./backend/src:/app/src`),
so a `git reset` updates their code directly and a `restart` is enough:

```bash
docker compose -f compose.yaml -f compose.prod.yaml restart ml backend
```

A full `up -d --build` is only needed when `requirements.txt` / `package.json` change.

## After deploying ml_service

The feature worker starts automatically and picks up any session the bridge has marked
`completed` that has no features yet. On a fresh deploy against existing data, that means
it will compute **every** completed session — which is the backfill. If you do not want
that, set `FEATURE_JOB_ENABLED=false` in `ml_service/.env.docker` first.

Check what it did:

```bash
docker compose exec ml python -m scripts.feature_jobs_cli --status
```

## Sanity checks

```bash
docker ps                              # all four containers up
ss -lntp | grep 5433                   # MUST show 127.0.0.1:5433, never 0.0.0.0:5433
curl -s -o /dev/null -w '%{http_code}' http://139.59.126.77/api/health
```

A container reporting `Up` is not proof the app inside it is alive — uvicorn's reloader
keeps the ML container running while the app crash-loops behind it. `ml_service` was dead
for weeks that way, and `docker ps` looked perfectly healthy the whole time. **Read the
logs.**
