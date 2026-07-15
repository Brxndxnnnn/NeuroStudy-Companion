-- 006_oasis_labels_image_sets_feature_jobs.sql
--
-- Three additions, all prerequisites for ML Phase 1 (EEG -> valence/arousal):
--   (a) OASIS identity + label spread on images
--   (b) the fixed, technician-configurable set of 24 images a session shows
--   (c) status for the feature/window job that runs after a session completes

BEGIN;

-- ─── (a) OASIS labels ─────────────────────────────────────────────────────────
-- images.filename cannot be relied on to carry the OASIS identity: the 24 rows
-- seeded so far are placeholder stock photos named image1..image25, and matching
-- them back to the 900 OASIS originals was already attempted and proved
-- impossible (best perceptual cosine 0.3-0.7 against a ~0.99 true-match score).
--
-- oasis_theme is the JOIN KEY back to OASIS.csv ("Acorns 1", "Snake 5") and is
-- the ONLY thing that makes a label recoverable. Any image uploaded without it
-- is unusable for training, permanently — the pixels alone are not enough.
--
-- valence_score / arousal_score already exist (rating means, 1-7 scale). The SDs
-- are new: they carry inter-rater disagreement, which the training pipeline uses
-- to down-weight or exclude images the raters could not agree on.
ALTER TABLE images
    ADD COLUMN IF NOT EXISTS oasis_theme text,
    ADD COLUMN IF NOT EXISTS valence_sd  real,
    ADD COLUMN IF NOT EXISTS arousal_sd  real;

-- Partial, so the existing placeholder rows (NULL theme) do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_images_oasis_theme
    ON images (oasis_theme) WHERE oasis_theme IS NOT NULL;


-- ─── (b) The 24 images a session shows ────────────────────────────────────────
-- Selection is FIXED and technician-configurable (client decision, 15 Jul): a
-- technician picks 24 images from the OASIS pool on the web, and subsequent
-- sessions use that set. No random draw.
CREATE TABLE IF NOT EXISTS image_sets (
    image_set_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text        NOT NULL,
    clinic_id    uuid        REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    is_active    boolean     NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   uuid        REFERENCES users(user_id) ON DELETE SET NULL
);

-- At most one active set per clinic — the one a new session picks up.
CREATE UNIQUE INDEX IF NOT EXISTS uq_image_sets_one_active_per_clinic
    ON image_sets (clinic_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS image_set_images (
    image_set_id uuid NOT NULL REFERENCES image_sets(image_set_id) ON DELETE CASCADE,
    image_id     uuid NOT NULL REFERENCES images(image_id)         ON DELETE RESTRICT,
    sequence_no  int  NOT NULL,
    PRIMARY KEY (image_set_id, image_id),
    -- DEFERRABLE so the config page can reorder a set inside one transaction
    -- without tripping over transient duplicate sequence numbers mid-update.
    CONSTRAINT uq_image_set_sequence UNIQUE (image_set_id, sequence_no)
        DEFERRABLE INITIALLY IMMEDIATE
);

-- Which set a session ran with. Provenance for the PROTOCOL only: editing a set
-- after the fact changes how a past session's config reads. It does NOT corrupt
-- the training data — events.image_id records what was actually put on screen,
-- and that is what the ML pipeline reads. If protocol provenance ever needs to be
-- airtight, version sets on edit instead of mutating them in place.
ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS image_set_id uuid
        REFERENCES image_sets(image_set_id) ON DELETE SET NULL;


-- ─── (c) Async feature-job status ─────────────────────────────────────────────
-- The window/feature computation runs OUTSIDE any request, after the bridge has
-- finished writing its EEG. The results page must be able to tell "not computed
-- yet" apart from "computed, no rows" apart from "the job crashed" — and zero
-- rows in a feature table reads as all three. Only the worker that ran the job
-- knows which, so the worker owns these columns.
--
-- Lifecycle: NULL -> running -> ready | failed.  A worker CLAIMS a session with
--   UPDATE sessions SET features_status = 'running', features_started_at = now()
--   WHERE session_id = $1 AND features_status IS DISTINCT FROM 'running'
--   RETURNING session_id
-- so a restart or a second worker cannot double-compute. features_started_at
-- exists so a crashed worker's row can be reclaimed after a staleness timeout
-- instead of wedging in 'running' forever.
ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS features_status      text,
    ADD COLUMN IF NOT EXISTS features_started_at  timestamptz,
    ADD COLUMN IF NOT EXISTS features_computed_at timestamptz,
    ADD COLUMN IF NOT EXISTS features_error       text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_features_status'
    ) THEN
        ALTER TABLE sessions
            ADD CONSTRAINT chk_features_status
            CHECK (features_status IS NULL
                   OR features_status IN ('running', 'ready', 'failed'));
    END IF;
END$$;

-- Supports the worker's poll: completed sessions that still need features.
CREATE INDEX IF NOT EXISTS idx_sessions_features_pending
    ON sessions (features_status)
    WHERE sync_status = 'completed';

COMMIT;
