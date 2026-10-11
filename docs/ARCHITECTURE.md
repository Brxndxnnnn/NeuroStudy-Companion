# NeuroStudy Companion — system reference

**This is the only design document in the repo.** It describes what is *actually
implemented*, not what was once planned. Seven earlier documents (four of them
`*-plan.md` written before the code existed) were deleted on 24 Jul 2026 because they
described superseded designs and were being quoted as if current.

Every non-obvious claim below cites the file that implements it. **If this document
and the code disagree, the code is right and this document is a bug.** When you change
behaviour, change the citation next to it or delete the claim.

The [README](../README.md) covers installation, dev setup, and release procedure. This
document covers how the system works.

---

## 1. What it is

A clinician runs an image-based session in a web app while the client wears a **Neeuro
SenzeBand** EEG headset. A Windows bridge streams EEG straight into the database. After
the session, background workers compute band-power features and an ML model predicts
emotional response (valence/arousal) from the EEG, trained against OASIS image norms.

Production: `https://clinics.axonview.sg` (droplet `139.59.126.77`).

```
 CLINIC MACHINE (Windows)                DROPLET (Docker Compose)
┌───────────────────────────┐          ┌──────────────────────────────────────────┐
│  NeuuroBridge (C# WPF)    │          │  nginx ── TLS, routing, update feed      │
│  SenzeBand ──BLE──▶ app   │          │   ├── /             → frontend (Next.js) │
│                           │ one-time │   ├── /api/         → backend (Express)  │
│  activation ──────────────┼─HTTPS───▶│   └── /bridge-updates/ → Velopack feed   │
│                           │          │                                          │
│  EEG ─────────────────────┼─TLS 5432▶│  db ── TimescaleDB (Postgres 17)         │
│  (binary COPY, direct)    │          │  ml ── FastAPI (internal only)           │
└───────────────────────────┘          └──────────────────────────────────────────┘
```

| Component | Tech | Role |
|---|---|---|
| `frontend/` | Next.js | Clinician web app |
| `backend/` | Express | REST API for the frontend only, plus bridge enrollment |
| `ml_service/` | FastAPI | Feature workers, ML Phase 1 training + inference |
| `neuuro_bridge/` | C# WPF (.NET Framework 4.8, x64) | Clinic-side BLE capture, writes EEG directly to the DB |
| `db/` | TimescaleDB | Hypertables + forced row-level security |
| `nginx/` | nginx + certbot | TLS, routing, bridge update feed |

---

## 2. Rules that are load-bearing

**1. The bridge writes directly to the database.** No backend hop in the data path.
Rows queue in memory and flush on a 500 ms timer (`DbUploader.cs:147`), so a database
hiccup never blocks BLE streaming.

**2. The backend serves the frontend only.** The single exception is one-time bridge
enrollment, `POST /api/clinics/activate` — deliberately public, because the activation
code *is* the credential (`backend/src/routes/index.js`).

**3. `ml_service` is never exposed to the internet.** It has no authentication of its
own and connects to the database as a `BYPASSRLS` role. nginx deliberately has no
`/ml/` location (`nginx/nginx.conf:89-94`); all ML calls go through the authenticated
backend at `/api/ml/...`, which enforces clinic ownership before proxying over the
internal compose network. The container only `expose`s its port.

**4. `sessions.predictions_status` / `predictions_model_version` belong solely to the
automatic prediction worker.** On-demand inference writes prediction *rows* only.
Writing those columns would make a session that never had an automatic pass look
processed, and the worker would skip it forever.

---

## 3. Session lifecycle

`sessions.sync_status` is constrained to four values
(`db/migrations/005_functions_and_updates.sql:48`):

```
unclaimed ──▶ claimed ──▶ recording ──▶ completed
```

| State | Set by | Meaning |
|---|---|---|
| `unclaimed` | bridge | Headset connected; row created with a pairing code, awaiting the web app |
| `claimed` | web | Clinician entered the pairing code; session bound to a client |
| `recording` | bridge | Technician pressed Start on the bridge; stimulus sequence running, bridge streams EEG |
| `completed` | bridge (also written by web on end) | Bridge finished its stop-grace drain and final flush |

**The bridge owns starting a session, not the website** (`BridgeController.StartSession
→ DbUploader.MarkRecording`, `MainWindow.xaml.cs:BtnStartSession_Click`). The technician
presses "Start Session" once the website shows the session as `claimed`; the button
writes `sync_status='recording'` (+ `start_time`) directly, and the website only
observes the transition by polling `GET /sessions/:id` for `bridge_recording_at` — it
has no start endpoint of its own. Ending a session is unchanged: the website still
writes `sync_status='completed'` and the bridge's sync poll reacts by draining and
closing (`BridgeController.PollSyncStatus`).

**`completed` is the only state that means "all my rows are in."** It is set after
`BridgeController.FinalizeStop → DbUploader.Dispose`. Everything downstream —
feature jobs, ML training, inference — gates on it (`queries.py`,
`fetch_completed_session_ids`). Do not substitute an earlier signal: the frontend
finishing its stimulus sequence does not imply the bridge has finished writing.

Sessions are created through the `create_clinic_session()` SECURITY DEFINER function,
which stamps the calling role's clinic.

### Stimulus timeline

The web app owns the stimulus sequence and writes `events` rows. Each image event
carries `shown_at` and `hidden_at`; the events table enforces image XOR question XOR
phase (`chk_events_stimulus`, `016:19` — originally image XOR question only, extended by
migration 016). Mid-sequence there is no explicit hide — the next event's create closes
the previous one server-side in the same request, so consecutive windows are contiguous
by construction and cannot overlap under latency spikes
(`frontend/src/app/session/active/page.js`).

**The protocol is 13 steps, not 2** (client requirement #3): a 5s countdown, a 1 min
eyes-closed baseline, a 3s countdown, a 1 min eyes-open baseline, and a 5s countdown lead
into the OASIS images + math questions block; the same four (5s/1min/3s/1min, no trailing
countdown) mirror it afterward, then recording stops. The nine countdown/baseline steps
are `events` rows with `phase` set instead of `image_id`/`question_id`
(`db/migrations/016_session_phase_markers.sql`, `chk_events_phase` for the fixed
vocabulary) — not a separate table, so they share the same shown_at/hidden_at/auto-close
mechanics and stay joinable through `eeg_readings`/`band_powers.current_event_id` exactly
like image/question events. `frontend/src/utils/events.js:buildEventWindows` and the
`/results` endpoint (`session.model.js:getSessionResult`) both derive a three-way
`stimulus_type` (`image` | `question` | `phase`) — anything that assumed only two used to
silently mislabel a phase marker as a question.

Event timestamps are calibrated against server time via `GET /api/time` and captured
with `requestAnimationFrame` (`frontend/src/utils/sessionClock.js`).

**Image display duration is 10 s** (`frontend/src/app/session/active/page.js:27`). This
is load-bearing for ML — see §6.

---

## 4. Data model

Migrations live in `db/migrations/` and are tracked in a `schema_migrations` table,
applied by `db/migrate.sh`. Current head: `013_schema_migrations_bootstrap.sql`.

**Streaming (TimescaleDB hypertables, written by the bridge):**

| Table | Contents |
|---|---|
| `eeg_raw_samples` | Raw ADC counts, 250 Hz, 4 channels (fp1, fp2, t3, t4) |
| `eeg_filtered_samples` | SDK-filtered µV, 250 Hz — the primary ML input |
| `eeg_readings` | ~2 Hz summary frames (last value + peak-to-peak per channel) |
| `band_powers` | ~1 Hz rows mixing two sources — see below |

⚠ **`band_powers` is not an SDK table.** The per-channel band values are the bridge's
**own** FFT (Hanning window + hand-written radix-2 transform, ~1 Hz), computed
independently of the vendor so the numbers are checkable rather than opaque. The same row
also carries the SDK's derived indicators (`attention`, `relaxation`, `mental_workload`)
plus signal quality, heart rate and SpO2, so the two can be compared side by side
(`BridgeController.cs:722`, `UploadBandPowers`). Do not describe this table as
vendor-supplied.

⚠ **`eeg_readings` is a timer snapshot, not a per-frame record.**
`UploadEegSnapshot` (`BridgeController.cs:685`) re-reads the last known values on a
timer and writes a row whether or not a new frame arrived. It therefore looks perfectly
continuous during a signal dropout. **Never use it as evidence that data was flowing** —
use `eeg_raw_samples` / `eeg_filtered_samples`, which are per-frame.

**Clinical:** `clinics`, `clients`, `users`, `sessions`, `events`, `images`,
`questions`, `questionnaires`, `questionnaire_questions`,
`session_questionnaire_responses`.

**Stimulus sets:** `clinic_stimulus_sets`, `clinic_stimulus_set_images` (and older
`image_sets` / `image_set_images`). A partial unique index enforces exactly **one active
set per clinic** (`005:224`), and `claim_session()` auto-assigns the clinic's active set
to a new session. Rotation is therefore clinic-wide, not per-client: swapping the active
set moves everyone at once. `sessions.stimulus_set_id` records what each session
actually used.

**Derived features** (post-session, written by `ml_service`): `elliptic_band_stats`,
`fft_band_powers` (Welch PSD over the recorded signal — distinct from the bridge's live
~1 Hz FFT above; both are ours, neither is the SDK's), `ml_insights`.

**ML:** `ml_models` (registry; one personal model per client, `client_id` NOT NULL),
`ml_model_sessions` (which sessions trained which model), `session_predictions`.

**Auth / tenancy:** `roles`, `permissions`, `role_permissions`, `revoked_tokens`,
`clinic_database_roles`, `clinic_activation_codes`.

---

## 5. Services

### Backend (Express)

Routes mount in `backend/src/routes/index.js`, and **the order is deliberate**:

1. Public: `POST /api/clinics/activate` (rate-limited), `GET /api/time`, `GET /api/health`
2. `/api/auth`
3. `authenticate` + `authenticatedApiLimiter` apply to everything below
4. `/api/ml` — proxy to `ml_service`, mounted **above** `dbContext` because
   `ml.routes.js` opens its own RLS-scoped connection only on the routes that need a
   clinic-ownership check
5. `dbContext` applies to everything below: `/users`, `/clinics`, `/sessions`,
   `/events`, `/images`, `/clients`, `/questions`, `/questionnaires`

Swagger at `/api-docs`.

### ml_service (FastAPI)

Endpoints (`ml_service/app/api/`):

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness |
| `POST /infer` | Ad-hoc inference |
| `POST /process/{session_id}` | Run the feature pipeline for one session |
| `GET /phase1/status` | Readiness: distinct labelled images vs target |
| `GET /phase1/sessions` | Completed sessions and prediction status |
| `GET /phase1/predictions/{session_id}` | Predictions, scoped to one model |
| `GET /phase1/clients/{client_id}/sessions` | A client's trainable sessions + their current model |
| `POST /phase1/train` | Fit + register one client's model (`client_id` required) |

Two background schedulers start with the app (`ml_service/app/main.py`):

| Worker | Cadence | Env override |
|---|---|---|
| Feature jobs | every 10 s | `FEATURE_JOB_INTERVAL_S`, `FEATURE_JOB_ENABLED` |
| Prediction jobs | every 15 s | `PREDICTION_JOB_INTERVAL_S` |

Both job workers claim work atomically and reclaim rows stuck longer than 15 minutes.
Training is not scheduled — it runs only when a technician starts it for a client.

---

## 6. ML Phase 1 — EEG → OASIS valence/arousal

### Labels

OASIS norms live in `data/oasis/OASIS.csv` (900 images, 1–7 scales), committed so
training reproduces anywhere. `ml_service/scripts/load_oasis_labels.py` joins them to
`images` on the OASIS **Theme** string, falling back to filename when `oasis_theme` is
NULL. The join is an exact dictionary lookup: a typo produces a *reported failure*, never
a silent mislabel. Run `--check` as the acceptance test after any image upload; an image
with no resolvable theme is permanently untrainable and cannot be recovered from pixels.

### Epoching (`ml_service/app/phase1/epochs.py`)

An epoch is **2 s of contiguous 250 Hz signal lying entirely inside one image's
window**, labelled with that image's OASIS norms. Windows step by 0.5 s, so a 10 s image
yields 17 epochs. Configuration in `phase1/config.py`:

| Gate | Value | Why |
|---|---|---|
| `epoch_s` | 2.0 | Delta runs to 0.5 Hz; a 1 s window cannot measure it |
| `step_s` | 0.5 | Shrink this, never the window, for more epochs |
| `flat_pkpk_uv` | 0.5 µV | Below this an electrode is railed, not quiet |
| `artefact_pkpk_uv` | 500 µV | Above this it is movement/EMG |
| `max_label_sd` | 2.0 | Rater disagreement makes a label unlearnable |

Epochs cannot straddle an image boundary — such a window carries EEG from two images but
can only take one label. Whole epochs are dropped when any channel is flat or
artefacted; imputing the bad channel would fabricate the asymmetry features, which are
differences *between* channels.

`ExtractionReport` records why epochs were dropped. ⚠ It is currently discarded by
`train.py` (`build_dataset(..., verbose=False)`, result assigned to `_`), so drop
reasons are not persisted anywhere and diagnosing a low yield requires re-running the
extraction by hand.

### Training (`ml_service/app/phase1/train.py`)

- Default algorithm `ridge` (`PHASE1_MODEL`); alternatives in `evaluate.make_models()`.
- **Sample size is the number of distinct images, not epochs or sessions.** Repeat
  sessions over the same set add repeated measurements of the same labels.
- Cross-validation is **grouped by image** so the same image cannot appear in both
  train and test folds — this is what stops fake accuracy
  (`test_leakage_guard_actually_guards`).
- Features are z-scored **within each session**, fitted on the training fold only.
  Without it a model scores well by learning "which session is this?".
- Scored against a predict-the-mean null baseline.

**Scope:** every model is personal. `train_and_save(conn, client_id)` fits one client's
model over their completed sessions, or an explicit hand-picked list recorded in
`ml_model_sessions` for auditability. There is no model shared across clients, and no
scheduled retrain — training starts from the Insights tab (or `scripts/phase1_cli.py
--train --client <id>`).

**Promotion:** a newly trained model **always** becomes its client's current one — a
technician asked for that specific model, and the honest score is displayed beside it.

**Serving** (`phase1_store.current_model`): a session is predicted with its own client's
current model. A client with no model yet has no predictions; their sessions stay
pending and are picked up automatically once a model is trained for them.

### Why image duration matters

A 2 s epoch inside a 3 s image left 1 s of slack and yielded at most 3 epochs. The
headset stalls for ~3.2 s at a time (§8), so a single stall destroyed an entire image.
At 10 s, one stall can never kill an image: the 6.8 s remaining split into at most two
runs, so one is always ≥ 3.4 s. Encoded in
`ml_service/app/tests/test_phase1_epochs.py` as
`test_ten_second_image_yields_seventeen_epochs`.

---

## 7. Security

- **Multi-tenancy:** forced row-level security on tenant tables. The backend sets
  `app.current_clinic_id` / `app.is_admin` per request from the JWT (`dbContext`
  middleware). Clinic DB roles are constrained by policy to their own rows
  (`db/migrations/010_database_roles.sql`).
- **Bridge DB access:** each clinic gets a login role inheriting `bridge_writer`
  (`010:348-378`) — INSERT on the four streaming tables; INSERT/SELECT on `sessions`;
  column-level UPDATE on `sessions(bridge_recording_at, sync_status)` only; and SELECT on
  `events` and `session_questionnaire_responses` so the bridge can follow web-side
  progress. Nothing further. Activation issues `ssl_mode=VerifyFull`
  (`clinic.controller.js:258`), so the connection verifies the server certificate rather
  than merely encrypting.
- **Enrollment:** activation codes are single-use and stored only as an HMAC-SHA256
  digest under a server-side pepper (`clinic.controller.js:19`), so the raw codes are
  never persisted. They are exchanged over HTTPS for per-clinic credentials stored
  DPAPI-encrypted in `%ProgramData%\NeuuroBridge\`, which survives updates.
- **Known gap:** the installer is unsigned, so SmartScreen warns on first install. An
  Authenticode certificate is a purely additive future step.

---

## 8. Bridge internals worth knowing

`DbUploader` batches into per-table queues and flushes every 500 ms via binary `COPY`.
Queue caps are large (200,000 frames) and unreachable in a normal session; overflow
drops are counted in `RawDropped` / `FiltDropped`.

Per-sample timestamps are **reconstructed** from a base tick plus a sample counter, not
measured per sample. When the reconstructed clock drifts more than a threshold behind
real arrival time, a resync jumps the counter forward (`DbUploader.cs:694`), which is
what produces a clean gap with exact 4 ms spacing on both sides. Resyncs are counted in
`RawResyncs` and surfaced as `RawGapSeconds`.

### RESOLVED: the "~3.2 s stalls" were an artefact of our own drift guard

Recorded here because it was written up for a month as an unexplained hardware fault,
and the reasoning is worth not repeating.

**The symptom.** Discrete stalls of 3.0–3.6 s, roughly one every 13 s; ~24% of a
recording missing. Raw and filtered showed identical gap structure; no BLE reconnects,
no flush errors, no queue overflow; device telemetry kept arriving throughout.

**What it actually was.** Two independent problems stacked:

1. *Real, continuous packet loss.* The SDK's own logs (`logs/`) show the device sends
   645-byte packages at 5/s as ~40 BLE notifications of 80 bytes per second, and only
   ~32 arrive. Each lost notification costs ~8× its size: the package it belonged to
   arrives 80 bytes short and is discarded whole (534 such packages in one 18-minute
   session), then the parser burns ~7 more notifications re-locking onto a header
   (3,654 `Cannot find Header!` events). Losses are **1 second granular** — one missed
   `filteredDataDelegate` callback is exactly 250 samples.
2. *A drift guard that hid them.* `MaxDriftTicks` was 3 s — far larger than a single
   1 s loss — so losses never tripped it individually. They accumulated, silently
   **compressing** the timeline, until the running total crossed 3 s and discharged as
   one lump. That is where "3.2 s every 13 s" came from: 3 s ÷ 24% loss = 12.5 s.

**The proof.** Across all 18 completed sessions in production (27 Jul 2026), every
recorded gap was ≥ 3.00 s and **not one was below it** — a distribution truncated
exactly at a constant in our source. Hardware has no reason to know that number.

**Why it mattered beyond the missing data.** Between discharges, samples either side of
a missing second were written as if contiguous, so EEG ran up to 3 s out of alignment
with the events table. Every downstream contiguity check was blind to it, because
compressed samples are still uniformly 4 ms apart — so a share of every image's epochs
carried the neighbouring stimulus's signal under the wrong label. Simulation against the
measured loss rates puts that at ~47% of epochs per image, though only ~3% of *images*
(the sample size that matters — see §6).

**What changed.** Per-stream, env-overridable drift tolerances (700 ms filtered /
1500 ms raw) so each loss lands as a real gap; a filtered-stream gap counter
(previously only raw had one — the ML input was the one stream whose dropout nobody
could measure); the trailing-gap seal extended to filtered; and the whole reconciliation
persisted onto the session row by migration 014 instead of being computed and discarded.
`sessions.timeline_version` separates pre-fix (compressed) from post-fix (honest) data —
`queries.MIN_TIMELINE_VERSION` gates training on it.

**Still open: the packet loss itself.** Mean 20% across all sessions, worst 67%, and no
session was clean. `BleConnectionTuner` asks Windows for a faster connection interval
(`ThroughputOptimized`), which is a *request* the peripheral may decline — unverified on
hardware. Measure any attempt with `neuuro_bridge/tools/analyse_sdk_log.py`, which
derives delivered-vs-elapsed seconds from the vendor log alone and needs no
instrumentation. Untested: onboard radio vs. dongle, band proximity, 2.4 GHz contention.

### ⚠ Open issue: restricted stimulus range

Until 24 Jul the active 24-image set was OASIS `I1`–`I24` — the first 24 rows
alphabetically, spanning valence 2.33–5.48 and arousal 2.23–4.42 on 1–7 scales. Narrow
target range attenuates correlation directly, so R² looks poor regardless of EEG
quality. Replaced by "Balanced ML set", chosen by farthest-point sampling over all 900
images to roughly double valence variance and triple arousal variance. **Any future set
should be selected for spread, not convenience.**

### Structural cap on personal models

Without stimulus-set rotation, every personal model is capped at the number of distinct
images in one set — 24 — forever. Repeat sessions add recordings, not labels. The
one-active-set-per-clinic index makes rotation a clinic-wide manual swap today.

---

## 9. Build, deploy, release

**CI** (`.github/workflows/ci.yml`) runs on push and PR to `main` and `develop`, three
jobs in parallel. All three run their own tests, and all three build the production
Docker image so a broken Dockerfile fails here rather than on deploy:

| Job | Steps |
|---|---|
| Frontend | `npm ci` → lint → test → build → docker build |
| Backend | `npm ci` → lint → test → docker build |
| ML service | `pip install` → pytest → docker build |

The ML job excludes `test_features.py` and `test_preprocessing.py` (`ci.yml:92`) — they
assert against one real recorded clinical session, and that patient data is neither
committed as a fixture nor reachable from CI. Every other suite runs on synthetic
signals or mocks. Branch protection blocks merging until all three pass.

**Branching:** feature branch → PR to `develop` → PR `develop` → `main`. A hotfix landing
directly on `main` auto-opens a sync PR back into `develop`
(`.github/workflows/hotfix-sync.yml`).

**Deploying the web stack** — `.github/workflows/deploy-production.yml`, manual trigger
only from the Actions tab. Merging to `main` does **not** auto-deploy. The workflow:

1. `git reset --hard` to the triggering ref on the droplet — deliberately the *triggering*
   ref, not `main`'s tip, so a rollback run against an older `v*` tag lands the old commit
2. brings up `db`, runs `db/migrate.sh` (forward-only, skips applied) **before** app code
3. `docker compose ... up -d --build` — the `--build` matters: `frontend` is a built image
   with no bind mount, so without it a frontend change silently does not deploy
4. restarts nginx explicitly (it can hold a stale upstream IP after containers are recreated)
5. health-checks `/api/health`, `/login`, `/admin`, `/profile`, `/history`
6. tags the release `vYYYY.MM.DD-<sha>`

Rollback = re-run the workflow against an earlier tag.

**Why `reset --hard` and not `pull`:** `main`'s history was rewritten on 15 Jul, so a
branch whose history was rewritten cannot fast-forward.

**Never edit tracked files on the droplet.** Anything that must survive a deploy has to
be in git — the working tree is not storage. Droplet-only state that legitimately lives
outside git: `.env.docker` secrets, and `/var/bridge-updates` (the Velopack feed).

**Bridge releases:** bump `<Version>` in `NeuuroBridge.Wpf.csproj` *first* — Velopack
compares version numbers, not file contents, so a release reusing a version reaches
nobody. Then run the "Deploy bridge update" workflow, which refuses to publish a version
already on the feed. Manual fallback: `packaging/pack.ps1` then `packaging/publish.ps1`.
Roll a bad release *forward*; never delete from the feed.

---

## 10. Testing

All three services have suites, and CI runs all of them (§9).

| Service | Runner | Location | Command |
|---|---|---|---|
| `ml_service` | pytest | `ml_service/app/tests/` | `docker compose exec ml python -m pytest app/tests -q` |
| `frontend` | Vitest + Testing Library | `src/**/*.test.js` | `npm test` in `frontend/` |
| `backend` | Node's built-in test runner | `src/**/*.test.js` | `npm test` in `backend/` (needs `.env.test`) |

The Phase 1 suite (15 tests, all passing) is the one that guards ML correctness:
leakage, epoch boundaries, label gating, dead-electrode reporting, dropout rejection,
window counts, feature sign conventions. `test_leakage_guard_actually_guards` is the
load-bearing one — if it fails, every downstream accuracy number is suspect.

`test_preprocessing.py` and `test_features.py` (30 tests) are **deliberately excluded
from CI** (`.github/workflows/ci.yml:92`) and fail on a fresh checkout. They assert
against one specific already-recorded clinical session's real EEG rather than synthetic
input, and that is real patient data — it is not committed as a fixture and CI is not
pointed at a database holding it. `conftest.py:17` is therefore
`TEST_SESSION_ID = "----"`, filled in locally when you want to run them. Every other
test file uses synthetic signals or mocks and runs in CI for real.
