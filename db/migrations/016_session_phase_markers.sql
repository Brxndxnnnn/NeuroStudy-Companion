-- 016_session_phase_markers.sql
--
-- Adds baseline/countdown phase markers to events (client requirement #3, "Standardised
-- EEG Experiment Workflow" — O1.1). The old 2-step protocol (images -> math questions)
-- becomes 13 steps: a countdown + two baseline periods (eyes closed / eyes open) BEFORE
-- the images/math block, and the mirror image of that AFTER it, before recording stops.
--
-- WHY A NEW COLUMN ON events, NOT A SEPARATE TABLE
-- --------------------------------------------------
-- eeg_readings/band_powers both key off current_event_id -> events(event_id), and every
-- downstream consumer (results endpoint, EEG chart markers, epoch extraction) already
-- treats "events" as the one stimulus timeline for a session. A baseline/countdown period
-- is a stimulus window exactly like an image or question is - it just isn't tied to a row
-- in images or questions - so it belongs in the same table under the same shown_at/
-- hidden_at/auto-close mechanics, not a second, unsynchronized timeline.
--
-- chk_events_stimulus becomes a three-way exclusive-or instead of two-way. phase is
-- constrained to a fixed vocabulary (chk_events_phase) so a typo fails loudly at insert
-- time instead of silently producing an unrecognised marker nothing downstream expects -
-- same "fail loud" convention as the OASIS theme join (see ml_service/scripts/load_oasis_labels.py).

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS phase text;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS chk_events_stimulus;

ALTER TABLE public.events
  ADD CONSTRAINT chk_events_stimulus CHECK (
    (image_id IS NOT NULL AND question_id IS NULL AND phase IS NULL) OR
    (image_id IS NULL AND question_id IS NOT NULL AND phase IS NULL) OR
    (image_id IS NULL AND question_id IS NULL AND phase IS NOT NULL)
  );

ALTER TABLE public.events
  ADD CONSTRAINT chk_events_phase CHECK (
    phase IS NULL OR phase IN (
      'countdown_pre',      -- 5s, session start -> baseline1 eyes closed
      'baseline1_closed',   -- 1 min, eyes closed
      'countdown_b1',       -- 3s, baseline1 closed -> open
      'baseline1_open',     -- 1 min, eyes open
      'countdown_images',   -- 5s, baseline1 open -> OASIS images
      'countdown_post',     -- 5s, math questions -> baseline2 eyes closed
      'baseline2_closed',   -- 1 min, eyes closed
      'countdown_b2',       -- 3s, baseline2 closed -> open
      'baseline2_open'      -- 1 min, eyes open -> recording stops (no countdown)
    )
  );

COMMENT ON COLUMN public.events.phase IS
  'Non-stimulus protocol phase (countdown/baseline). Mutually exclusive with image_id/question_id (chk_events_stimulus); NULL for ordinary image/question events.';

CREATE INDEX IF NOT EXISTS idx_events_phase
  ON public.events (session_id, phase)
  WHERE phase IS NOT NULL;
