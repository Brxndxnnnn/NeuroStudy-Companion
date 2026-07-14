# Handoff spec — feature jobs, image sets, OASIS upload

Three pieces of integration work, split by owner. All three are backed by
migration `db/migrations/006_oasis_labels_image_sets_feature_jobs.sql`.

---

## 0. Findings from the deployed `elliptic_band_stats` (15 Jul) — read first

The table is live and the endpoint works, but querying production turned up five
things that need action before anyone reads results off this data.

**a. The window is 1.0 s. It needs to be 2.0 s.** Deployed rows carry
`window_size_s = 1.0, step_s = 0.5`. The step is right; the window is not. Delta runs
down to 0.5 Hz — **half a cycle in a 1-second window** — so the delta statistics are
not measuring delta. The window decides whether one measurement is trustworthy; the
step decides how many you get. Shrink the step, never the window. Re-run at
**2 s / 0.5 s**.

**b. Only ONE session is backfilled.** `1087fe73-3ddb-4105-b27b-5b7dab2f131c`
(29 Jun) is the only session with any rows — 521 windows × 4 channels. Every other
completed session returns an empty array. The job needs a backfill over existing
sessions, not just new ones.

**c. `mean` is not an amplitude and is near-useless.** The signal is bandpassed
*before* the statistic is taken, and a bandpassed signal is zero-mean by
construction. Measured on fp1: `|mean| / std` is 0.13 for delta, 0.06 theta, **0.03
alpha, 0.01 beta, 0.01 gamma**. `std` is the RMS amplitude and is the meaningful
column. Keep `mean` if it's free, but nothing should be plotted or trained on it
without knowing this.

**d. `peak` carries artefacts orders of magnitude above EEG.** On fp1 the median peak
is in the tens of µV but the **maximum is 55,814 µV — 55 millivolts**, and t4 reaches
79,138 µV. That is not brain activity. Anything consuming `peak` needs to reject or
clamp these; the results page caps its axis at the 99th percentile, or a single pop
would flatten every real trace onto the axis.

**e. The repo migration does not match production.** `db/migrations/005` defines
`elliptic_band_stats` with a `band` text column and `mean`/`std`/`peak`. **The
deployed table has no `band` column** — it is one row per *(session, time_start,
channel)* with the bands as columns (`delta_mean`, `delta_std`, `delta_peak`, …
`gamma_peak`) plus `window_number`. The deployed shape is fine; the migration in the
repo is stale and will mislead the next person who reads it. Reconcile it.

---

## 1. Zhengda — the worker is BUILT. You write one function.

**The scheduling, claiming, status-tracking and backfill machinery already exists**
in `ml_service/app/workers/feature_jobs.py`, and it starts automatically with the ML
service (`app/main.py` lifespan → APScheduler). Nobody runs a script. When a session
reaches `sync_status = 'completed'`, the worker picks it up within ~10 seconds.

It is currently **not running**, on purpose. It logs:

```
Feature job DISABLED: cannot import app.features.elliptic:compute_session_features
(No module named 'app.features.elliptic'). Create that module with
compute_session_features(conn, session_id) -> int
```

That is the whole task. **Create `ml_service/app/features/elliptic.py`:**

```python
def compute_session_features(conn, session_id: str) -> int:
    # 1. DELETE FROM elliptic_band_stats WHERE session_id = :sid   <-- REQUIRED
    # 2. read EEG:  app.data_access.queries.fetch_filtered_samples(conn, session_id)
    #    (already µV — do NOT apply the ADC scale)
    # 3. window it: 2.0s window, 0.5s step
    # 4. elliptic bandpass per band, then mean/std/peak per channel
    # 5. INSERT the rows
    return rows_written
```

The contract, in full, is in `ml_service/app/features/__init__.py`. Four points:

- **`conn` is already inside a transaction the worker owns.** Do not commit it. That
  is what guarantees a failed run leaves no half-written rows behind.
- **It MUST be idempotent** — start by deleting that session's existing rows. The
  session *will* be recomputed (backfill, changed window size, reclaimed stale job),
  and without the delete every re-run silently doubles the rows.
- **Return the row count.** Returning 0 is fine and records as `ready`: a session with
  dead electrodes has no features, and that is a real outcome, not a failure.
- **Raise on failure.** The message lands in `sessions.features_error` and is shown to
  whoever opens the results page, so make it worth reading.

Nothing else is needed. The worker does the claiming, the retries, the status writes.

### Running it by hand

```bash
python -m scripts.feature_jobs_cli --status     # what state is everything in
python -m scripts.feature_jobs_cli --once       # one poll cycle now
python -m scripts.feature_jobs_cli --backfill   # requeue EVERY completed session
```

**`--backfill` is what you need first**: only one session has rows today, and it was
computed at a 1 s window instead of 2 s (see finding *a* above). Requeueing recomputes
the lot — safe precisely because the compute function is idempotent.

### Prerequisite

Migration `006_oasis_labels_image_sets_feature_jobs.sql` must be applied — it adds the
`features_status` / `features_started_at` / `features_computed_at` / `features_error`
columns the worker writes.

---

## 1b. Reference — why the worker is built the way it is

### The trigger: `sessions.sync_status = 'completed'`. Nothing earlier.

**Do not trigger on the frontend submitting the math answers.** There is a race.
The bridge's stop path is:

```
StopSession()
  -> 4-second stop-grace drain      (catches BLE frames still in flight)
  -> FinalizeStop()
     -> DbUploader.Dispose()
        -> final Flush()            <-- the last EEG rows land HERE
     -> MarkCompletedInternal()     <-- only NOW is sync_status = 'completed'
```

When the frontend finishes its stimulus sequence, the bridge may still be
draining and flushing. A job that starts there computes on a **truncated tail** of
the recording — silently, with no error, every session slightly short at the end.

`sync_status = 'completed'` is written by the bridge *after* its final flush. It is
the bridge saying "all my rows are in." It is the only safe signal.

### The mechanism: poll the DB. No backend coordination needed.

`ml_service` already has DB credentials and `data_access`. Have it poll — this
matches how the bridge already works (write direct to the DB, no gateway), and it
needs nothing from Eugene. An HTTP trigger is an optional latency tweak later, not
a prerequisite.

```
every ~5s:
  SELECT session_id FROM sessions
  WHERE  sync_status = 'completed' AND features_status IS NULL
  LIMIT 10

  -- CLAIM atomically, so a restart or a second worker cannot double-compute:
  UPDATE sessions
  SET    features_status = 'running', features_started_at = now()
  WHERE  session_id = $1
    AND  features_status IS DISTINCT FROM 'running'
  RETURNING session_id            -- no row returned => someone else has it, skip

  ... compute windows, write feature rows ...

  UPDATE sessions
  SET    features_status = 'ready', features_computed_at = now()
  WHERE  session_id = $1
```

On exception: `features_status = 'failed'`, `features_error = <message>`.

Also reclaim stale claims, or a worker that crashes mid-job wedges that session in
`running` forever:

```
UPDATE sessions SET features_status = NULL
WHERE features_status = 'running' AND features_started_at < now() - interval '15 minutes'
```

### You own the status columns

`features_status` / `features_started_at` / `features_computed_at` /
`features_error` are on `sessions` (migration 006). **Only the worker writes them.**
That is the whole point: zero rows in a feature table reads identically as "not
started", "still running", "finished but empty" and "crashed" — and only the thing
that ran the job knows which.

### Window parameters

**2 s window, 0.5 s step.** The two knobs do different jobs: the *window* decides
whether one measurement is trustworthy, the *step* decides how many you get. Delta
runs to 0.5 Hz — half a cycle in a 1 s window — so 1 s cannot measure it. Shrink
the step, never the window.

Real image duration is **10 s** (the 3 s in `IMAGE_DISPLAY_MS` is a dev setting), so
this gives 17 windows per image.

### Units — do not merge with the bridge's data

Your values are elliptic-filter **amplitude** stats (µV). `band_powers` holds the
bridge's FFT **power** (µV²). Different quantities. Never plot on one axis, never
write into `band_powers`.

---

## 2. Eugene — image sets (the 24 images a session shows)

Client decision (15 Jul): **fixed and technician-configurable. No random.** A
technician picks 24 images from the pool on the web; subsequent sessions use them.

Migration 006 adds:

- `image_sets (image_set_id, name, clinic_id, is_active, created_at, created_by)`
  — unique partial index enforces **at most one active set per clinic**
- `image_set_images (image_set_id, image_id, sequence_no)` — the 24, in order
- `sessions.image_set_id` — which set the session ran with

Endpoints needed:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/images` | The pool, paginated/searchable. Must return `valence_score`, `arousal_score`, `valence_sd`, `arousal_sd` so the technician can pick a spread. |
| `GET` | `/image-sets` | List sets for the clinic. |
| `POST` | `/image-sets` | Create a set from 24 ordered `image_id`s. |
| `PUT` | `/image-sets/:id` | Replace the 24 / reorder. |
| `POST` | `/image-sets/:id/activate` | Make it the active set (deactivate the rest). |
| `GET` | `/sessions/:id/images` | The ordered images for THIS session — what the active-session page fetches instead of "all images". |

Two notes:

- **Sequence order matters.** Store and return `sequence_no`. Order effects
  (fatigue, habituation) over 24 images at 10 s each are a real confound.
- Editing a set changes how a **past** session's config reads. This does not corrupt
  the training data — `events.image_id` records what was actually shown, and that is
  what the ML reads — but if protocol provenance needs to be airtight, version sets
  on edit rather than mutating them.

---

## 3. Eugene — the OASIS image upload (do this before uploading, not after)

**`images.oasis_theme` must be set for every uploaded image.** It is the join key
back to `data/oasis/OASIS.csv` ("Acorns 1", "Snake 5") and it is the **only** thing
that makes a label recoverable.

This is not hypothetical. The 24 placeholder images currently in the DB
(`image1..image25`) cannot be labelled: we tried to recover the mapping by
perceptually matching them against the 900 OASIS originals and failed — best cosine
0.3–0.7, where a true re-encoded match scores ~0.99. **An image uploaded without its
theme is permanently unusable for training. The pixels are not enough.**

After uploading, run the acceptance check:

```bash
cd ml_service
python -m scripts.load_oasis_labels --check     # names every unlabellable image
python -m scripts.load_oasis_labels             # writes the labels
```

`--check` exits non-zero and lists exactly which images cannot be joined, while the
upload is still fresh enough to fix. `data/oasis/OASIS.csv` is committed to the repo
as the source of truth, so this runs the same on any machine.

Migration 006 also adds `images.valence_sd` / `arousal_sd` — the schema only had
means. The rater SDs carry inter-rater disagreement, which the training pipeline
uses to exclude images nobody agreed on (an unlearnable target).

---

## One ask that is worth raising with the client

A single fixed set of 24 images means **24 distinct valence/arousal labels — total,
across the entire study.** Not per session: total. A hundred sessions still yields 24
label points, because every session shows the same 24 images. The regression's sample
size is the number of distinct *labels*, not the number of *epochs*.

The fix costs the client nothing and is fully compatible with "fixed and
configurable": **define several sets of 24 and assign different sets to different
participants.** Four sets → 96 distinct images. Eight → 192. Nothing is random; the
technician still controls exactly which images appear. The data model above already
supports it — a session points at *a* set, not *the* set.

Without it, ML Phase 1 is capped at 24 label points and generalisation to an unseen
image cannot be established.
