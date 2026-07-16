-- 008_prediction_ground_truth.sql
--
-- Store the image's true OASIS valence/arousal alongside each prediction, so the
-- Insights tab can plot PREDICTED vs ACTUAL rather than predictions in a vacuum.
--
-- Inference runs over OASIS-labelled images only, so wherever a prediction row
-- exists its image has a ground-truth rating — these columns are populated for
-- every row. They are nullable so the migration is additive and any legacy rows
-- (there are none in normal operation) don't block it.

ALTER TABLE session_predictions
    ADD COLUMN IF NOT EXISTS actual_valence double precision,
    ADD COLUMN IF NOT EXISTS actual_arousal double precision;
