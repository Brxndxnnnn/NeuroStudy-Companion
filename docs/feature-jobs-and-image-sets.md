# Handoff spec — feature jobs, image sets, OASIS upload

Three pieces of integration work, split by owner. All three are backed by
migration `db/migrations/006_oasis_labels_image_sets_feature_jobs.sql`.

---

## 1. Zhengda — when the window/feature job runs, and how it reports

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
