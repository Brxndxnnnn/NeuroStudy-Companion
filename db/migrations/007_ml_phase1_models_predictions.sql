-- 007_ml_phase1_models_predictions.sql
--
-- ML Phase 1 productionisation: a model registry, per-session predictions, and the
-- status machinery that drives inference — mirroring the features_status pattern
-- that migration 006 added for the elliptic feature worker.
--
-- Additive only: new tables + new nullable columns. Nothing existing is altered or
-- dropped, so applying this to a live database cannot disturb current data.
--
-- Deliberately NO row-level security on the two new tables. They are read and
-- written exclusively by ml_service, which connects as a BYPASSRLS role
-- (neurostudy_user / bridge_writer) and would bypass any policy anyway; adding RLS
-- here would only be dead weight. The tables hold valence/arousal numbers, not PII.

-- ── Model registry ───────────────────────────────────────────────────────────
-- One row per trained model. The pipeline fits a model on all available labelled
-- data, saves the artifact to disk (MODEL_DIR), and records what it was and how it
-- scored here. Exactly one row is the "current" model that inference serves.
CREATE TABLE IF NOT EXISTS ml_models (
    model_version      serial PRIMARY KEY,
    algo               text        NOT NULL,          -- 'ridge' | 'random_forest'
    artifact_path      text        NOT NULL,          -- e.g. /app/saved_models/phase1_v3.joblib
    trained_at         timestamptz NOT NULL DEFAULT now(),
    n_epochs           integer,
    n_distinct_images  integer,
    n_sessions         integer,
    -- Grouped-by-image cross-validation scores, so the registry carries the honest
    -- number next to the artifact. NULL is allowed (a model trained on too little
    -- data to cross-validate is still a real, servable artifact).
    cv_r2_valence      double precision,
    cv_r2_arousal      double precision,
    cv_mae_valence     double precision,
    cv_mae_arousal     double precision,
    null_r2_valence    double precision,              -- predict-the-mean baseline
    null_r2_arousal    double precision,
    is_current         boolean     NOT NULL DEFAULT false
);

-- At most one current model. A partial unique index enforces it at the DB level so
-- a promotion race cannot leave two models both flagged current.
CREATE UNIQUE INDEX IF NOT EXISTS ml_models_one_current
    ON ml_models (is_current) WHERE is_current;

-- ── Per-session predictions ──────────────────────────────────────────────────
-- Inference output: one row per epoch (2 s window, 0.5 s step) with the model's
-- predicted valence/arousal. Stamped with the model_version that produced it, so a
-- session's insight stays reproducible even after a newer model is promoted.
CREATE TABLE IF NOT EXISTS session_predictions (
    session_id     uuid        NOT NULL REFERENCES sessions(session_id)   ON DELETE CASCADE,
    model_version  integer     NOT NULL REFERENCES ml_models(model_version) ON DELETE CASCADE,
    window_start   timestamptz NOT NULL,
    window_end     timestamptz NOT NULL,
    pred_valence   double precision NOT NULL,
    pred_arousal   double precision NOT NULL,
    image_id       uuid        REFERENCES images(image_id),   -- image on screen (NULL if none)
    computed_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, model_version, window_start)
);

CREATE INDEX IF NOT EXISTS session_predictions_session
    ON session_predictions (session_id);

-- ── Inference status on sessions ─────────────────────────────────────────────
-- Mirrors features_status (migration 006). NULL = not started; 'running' = claimed;
-- 'ready' = predictions written; 'failed' = see predictions_error. predictions_
-- model_version records which model produced the current rows.
ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS predictions_status        text,
    ADD COLUMN IF NOT EXISTS predictions_started_at    timestamptz,
    ADD COLUMN IF NOT EXISTS predictions_computed_at   timestamptz,
    ADD COLUMN IF NOT EXISTS predictions_error         text,
    ADD COLUMN IF NOT EXISTS predictions_model_version integer;
