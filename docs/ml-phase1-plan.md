# ML Phase 1 — Plan & Flow

**Goal:** predict an image's OASIS *valence* and *arousal* from a short window of
filtered EEG, and surface the result in the web **Insights** tab.

**Acceptance bar for "done" (set by Brandon):** predictive *accuracy does not
matter* — we know the dataset is far too small to train a good model. What must
exist is the **full end-to-end flow**, runnable on whatever data we have: you can
train a model, that model produces per-session predictions automatically, and the
Insights tab shows something real (the model, its metrics, and per-session
results). A meaningless-but-real model that flows through the whole pipeline
satisfies this; a good model is a later, data-gated concern.

---

## 1. The core principle: training and inference are two separate loops

Every design decision below follows from this split. Collapsing the two is the
single biggest source of confusion.

| | **Inference** | **Training** |
|---|---|---|
| What it does | Runs an *already-trained* model over one session's EEG to produce predictions | Fits a *new* model on *all* accumulated labelled data |
| Clock | Per session, fast, online | Occasional, slow, batch, offline |
| Trigger | A session reaching `sync_status='completed'` | A weekly schedule, or an admin action |
| Who sees it | Technician (indirectly — insights just appear) | Nobody on the floor; admin/ops only |
| Frontend button? | **No** — fully automatic background | **No technician button.** Admin-only manual trigger, optional |

The model is a **frozen artifact between retrains.** New data does not change
today's predictions — it changes the *next* training run's inputs. This keeps
inference stable and auditable, and lets us always answer "which model version
produced this insight."

---

## 2. Architecture

```
                          ┌───────────────────────────────────────────┐
                          │              ml_service (FastAPI)          │
  ┌──────────┐  writes    │                                           │
  │  Bridge  │──EEG──────▶│  DB   ◀── background workers (APScheduler)│
  │  (C#)    │            │        • feature worker  (elliptic stats) │
  └──────────┘            │        • prediction worker (Phase 1) [NEW]│
                          │        • training cron     (Phase 1) [NEW]│
                          │                                           │
                          │  HTTP:  /phase1/status   (readiness)      │
                          │         /phase1/model    (current + hist) │
                          │         /phase1/predictions/{session}     │
                          │         /phase1/train    (admin) [NEW]    │
                          └────────────────────┬──────────────────────┘
                                               │ nginx /ml/
                                    ┌──────────▼───────────┐
                                    │  Frontend Insights   │
                                    │  tab (Next.js)       │
                                    └──────────────────────┘
```

### Code map

| Concern | File | Status |
|---|---|---|
| Config / knobs | `ml_service/app/phase1/config.py` | ✅ exists |
| Epoching (label-gated) | `ml_service/app/phase1/epochs.py` | ✅ exists — needs label-free mode for inference |
| Feature extraction (50 features) | `ml_service/app/phase1/features.py` | ✅ exists |
| Dataset assembly | `ml_service/app/phase1/dataset.py` | ✅ exists |
| Cross-validation / evaluation | `ml_service/app/phase1/evaluate.py` | ✅ exists (CV only — no final fit/save) |
| **Fit-final + persist model** | `ml_service/app/phase1/train.py` | ❌ NEW |
| **Inference on one session** | `ml_service/app/phase1/inference.py` | ❌ NEW |
| **Prediction worker** | `ml_service/app/workers/prediction_jobs.py` | ❌ NEW |
| **Training cron** | wired in `app/main.py` lifespan | ❌ NEW |
| Readiness query | `ml_service/app/data_access/phase1_status.py` | ✅ NEW (this session) |
| Readiness endpoint | `ml_service/app/api/insights.py` | ✅ NEW (this session) |
| **Model / predictions endpoints** | `ml_service/app/api/insights.py` | ❌ extend |
| CLI | `ml_service/scripts/run_phase1.py`, `load_oasis_labels.py` | ✅ exists (both fixed this session) |
| Insights tab | `frontend/src/app/insights/page.js` | ✅ readiness view (this session); ❌ model + predictions view |

---

## 3. The ML pipeline internals (what a "model" actually is here)

Grounded in the existing code:

1. **Epoch.** For each image event, take the filtered EEG (`eeg_filtered_samples`,
   250 Hz, µV) recorded while that image was on screen and cut it into **2 s
   windows, 0.5 s step** (`config.py`). A window must lie *entirely* inside one
   image's `shown_at..hidden_at` — windows straddling a boundary, spanning a
   Bluetooth dropout, or containing a flat/dead channel are dropped.
2. **Label (training only).** Every epoch from image X is labelled with X's OASIS
   `valence_mean` / `arousal_mean`. Images whose rater SD is too high are excluded.
   *Every epoch from one image shares one label* — which is why the CV split is
   grouped by image (see step 5).
3. **Features (50 per epoch, `features.py`).** Per channel (fp1, fp2, t3, t4):
   5 absolute band powers + 5 relative band powers + 2 ratios (theta/beta,
   alpha/beta) = 48, plus `frontal_alpha_asymmetry` (the standard valence
   correlate) and `temporal_alpha_asymmetry`.
4. **Normalise.** Per-session z-score of features, so the model can't cheat by
   learning "which session is this?" and regressing session-mean valence.
5. **Model + evaluation (`evaluate.py`).** Classical only — **ridge** and
   **random forest** (no deep learning; the data can't constrain it). Scored with
   **GroupKFold grouped by image** against a **predict-the-mean null baseline**. A
   random split here would leak near-duplicate sibling epochs across train/test
   and report a fake-high score (our harness demonstrates R²≈0.98 on pure noise
   under a random split vs correctly-negative under the grouped split).

> Inference reuses steps 1, 3, 4 — but **not** step 2. Prediction does not need
> the image to have a label; it predicts valence/arousal *from EEG alone*. This is
> why every completed session can get predictions, even ones recorded on the old
> placeholder images — so the tab always has something to show.

---

## 4. Flow A — per-session inference (automatic, on session end)

```
Session ends
  │
  ▼
Bridge finishes draining + final flush, sets sessions.sync_status = 'completed'
  │
  ▼
feature worker (existing) computes elliptic band stats  →  results chart
  │
  ▼
prediction worker (NEW) polls: sync_status='completed'
                               AND predictions_status IS NULL
                               AND a current model exists
  │  atomic claim (UPDATE ... WHERE predictions_status IS DISTINCT FROM 'running'
  │                RETURNING) — same pattern as the feature worker
  ▼
load current model (ml_models.is_current) → epoch session (LABEL-FREE)
                                          → features → per-session z-score
                                          → model.predict()
  │
  ▼
write rows to session_predictions (stamped with model_version)
set sessions.predictions_status = 'ready'  (or 'failed' + error)
  │
  ▼
Insights tab reads them → shows predicted valence/arousal trajectory
```

If **no current model exists yet**, the worker leaves `predictions_status` NULL
and the tab shows "no model trained yet" — not an error.

## 5. Flow B — training (scheduled + admin-manual, never technician)

```
Trigger:  weekly cron  OR  admin POST /phase1/train
  │
  ▼
build_dataset over ALL completed sessions  (dataset.py)
  │
  ├─ too little new data / < 2 distinct images → skip, log, do nothing
  ▼
cross-validate (GroupKFold-by-image, vs null)   → record metrics
  │
  ▼
fit a FINAL model on all the data (not a fold)  [train.py, NEW]
  │
  ▼
save artifact  →  MODEL_DIR/phase1_v{n}.joblib   (persistent volume)
insert ml_models row (version, path, metrics, trained-on counts)
  │
  ├─ promotion gate [IMPLEMENTED, train.py _should_promote]: a retrain only becomes
  │  is_current if it does not regress the model in service —
  │    • no current model → promote (inference must have something to serve);
  │    • neither new nor incumbent can be CV-scored (tiny-data regime) → promote the
  │      newer (no honest score to protect; keeps the flow visibly working now);
  │    • new unscored but incumbent scored → keep incumbent;
  │    • new scored → must beat the null on BOTH targets AND not score below a
  │      scored incumbent, else keep incumbent.
  │  A model that isn't promoted is still registered in ml_models as a candidate.
  ▼
flip is_current → next inference runs use the new model
```

**No-new-data guard [IMPLEMENTED]:** the weekly cron skips entirely if no new
epochs/sessions have arrived since the current model, so a quiet week doesn't mint a
redundant version. A manual `POST /phase1/train` passes `force=True` to bypass this
(operator asked explicitly) — but the promotion gate above still applies.

**Artifact pruning [IMPLEMENTED]:** each train writes a new `.joblib`; the trainer
prunes superseded files, keeping the newest few (`PHASE1_KEEP_ARTIFACTS`, default 5)
plus whichever is current. The `ml_models` rows (and their metrics) are kept.

**Insight freezing:** predictions are stamped with the `model_version` that
produced them. A newly promoted model applies to **new sessions going forward**;
past sessions are *not* silently recomputed (keeps a session's insight stable and
auditable). An explicit admin `POST /phase1/predictions/recompute` can re-run
everything against the current model if ever wanted.

---

## 6. Data model changes (migration `007_ml_phase1_models_predictions.sql`, NEW)

**`ml_models`** — one row per trained model (the registry):

```
model_version      serial primary key
algo               text                     -- 'ridge' | 'random_forest'
artifact_path      text                     -- MODEL_DIR/phase1_v{n}.joblib
trained_at         timestamptz default now()
n_epochs           int
n_distinct_images  int
n_sessions         int
cv_r2_valence      double precision          -- grouped-by-image CV
cv_r2_arousal      double precision
cv_mae_valence     double precision
cv_mae_arousal     double precision
null_r2_valence    double precision          -- predict-the-mean baseline
null_r2_arousal    double precision
is_current         boolean default false     -- exactly one true
```

**`session_predictions`** — the per-session inference output:

```
session_id     uuid  references sessions
model_version  int   references ml_models
window_start   timestamptz
window_end     timestamptz
pred_valence   double precision
pred_arousal   double precision
image_id       uuid  null   -- the image on screen (null if none / rest)
computed_at    timestamptz default now()
primary key (session_id, model_version, window_start)
```

**`sessions`** — new columns mirroring the existing `features_status` machinery:

```
predictions_status         text     -- null | 'running' | 'ready' | 'failed'
predictions_error          text
predictions_model_version  int
```

> **Prediction granularity (default):** store **per-window trajectory** (richest —
> the tab can plot a valence/arousal line over the session and aggregate if it
> wants). Alternative was one aggregate per session; per-window is the recommended
> default.

---

## 7. Triggers & roles — summary

| Action | Trigger | Who | Frontend surface |
|---|---|---|---|
| Compute insights for a session | `sync_status='completed'` → prediction worker | automatic | none (results just appear) |
| Retrain model (routine) | weekly cron in ml_service | automatic | none |
| Retrain model (on demand) | `POST /phase1/train` | **admin only** | optional admin/model-mgmt view |
| Recompute all predictions | `POST /phase1/predictions/recompute` | **admin only** | optional |

**No training control is ever exposed to technicians**, and nothing about
training sits on the session workflow.

---

## 8. Insights tab — what it shows, in stages

1. **Readiness** *(built this session)* — how much OASIS-labelled EEG has
   accumulated, and whether we're close to trainable. `GET /phase1/status`.
2. **Model card** *(to build)* — current model version, algorithm, trained-on
   counts, CV R²/MAE vs null baseline, trained-at. `GET /phase1/model`.
3. **Per-session predictions** *(to build)* — pick a completed session, plot its
   predicted valence/arousal trajectory (reuse `TimeSeriesChart`), ideally overlaid
   on the image markers, with the model version that produced it.
   `GET /phase1/predictions/{session_id}`.
4. **Progression** — "predictions computed for N of M sessions" and model-version
   history over time.

---

## 9. Status — BUILT (pending deploy)

The full loop is implemented and verified end-to-end against the live DB (a model
was trained, all 24 completed sessions were inferred, all endpoints returned
correct JSON; the verification data was then reset so prod is clean pending an
on-droplet train).

**Done:**
- ✅ Pipeline runs against the **live DB** (`valence_score → valence_mean` fixed).
- ✅ CLIs Windows-safe (UTF-8); `load_oasis_labels --check` truthful (900 matched).
- ✅ Migration `007` — `ml_models`, `session_predictions`, `sessions.predictions_*`
  — **written and applied to the prod DB**.
- ✅ `phase1/train.py` — fit-final + save `.joblib` + register in `ml_models`, with
  tiny-data guards (`n_splits ≤ n_distinct_images`, zero-variance z-score epsilon).
- ✅ `phase1/inference.py` + label-free mode in `epochs.py` (`require_label=False`).
- ✅ `workers/prediction_jobs.py` — inference worker (atomic claim, stale reclaim),
  registered in `main.py` alongside a weekly training cron.
- ✅ Endpoints in `api/insights.py`: `/phase1/status` (now model-aware), `/model`,
  `/sessions`, `/predictions/{id}`, `POST /train`.
- ✅ `scripts/phase1_cli.py` — operator lever (`--train`, `--predict-backfill`).
- ✅ Insights tab: model card (metrics vs null) + per-session prediction chart.
- ✅ `compose.yaml` — named volume `ml-models:/app/saved_models`.

**Remaining = deploy only (owner action):**
1. `docker compose restart ml` (or `up -d` with the volume) — picks up the code.
2. Rebuild/redeploy the frontend.
3. After deploy, produce a model ON THE DROPLET so the artifact lives in the volume:
   `POST /ml/phase1/train`, or `python -m scripts.phase1_cli --train` in the ml
   container, or just wait for the weekly cron. The prediction worker then fills in
   predictions on the next tick.

**Accuracy is meaningless at current data volume (10 epochs / 4 images) — the model
does not beat the null baseline, which is expected and explicitly acceptable.** The
flow is what's proven; accuracy follows once sessions are recorded over OASIS images.

---

## 10. Open decisions (defaults chosen; override if desired)

| Decision | Default | Alternative |
|---|---|---|
| Prediction granularity | per-window trajectory | one aggregate per session |
| Training trigger | weekly cron + admin manual | manual only |
| Model pointer | `ml_models` DB table (`is_current`) | metadata file beside the artifact |
| Insight recompute on new model | freeze (new model → new sessions only) | recompute all on promotion |
| Promotion gate | **gate on beating current + null (IMPLEMENTED)** | promote unconditionally |
| Retrain on no new data | **skip (cron); force bypasses (IMPLEMENTED)** | always retrain |
| Short-session inference | **skip below `PHASE1_MIN_SESSION_EPOCHS`=4 (IMPLEMENTED)** | predict anyway |
| Out-of-range predictions | **clamp to OASIS 1–7 (IMPLEMENTED)** | leave raw |

See also: [feature-jobs-and-image-sets.md](feature-jobs-and-image-sets.md),
[session-data-flow.md](session-data-flow.md).
