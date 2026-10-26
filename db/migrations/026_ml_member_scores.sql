-- 026: Each group-model member's own cross-validated score (26 Oct 2026).
--
-- Training already scores a group model by holding one person out at a time. Until now
-- only the pooled score was kept. Keeping each member's own score (how well the model
-- served them while they were the held-out person) gives the range a client OUTSIDE the
-- group is compared against when a technician checks how they compare with the group.
--
-- Nullable: models trained before this migration have no per-member scores until the
-- group is retrained.
--
-- Additive only. Safe to re-run.

ALTER TABLE public.ml_model_sessions
    ADD COLUMN IF NOT EXISTS cv_n_epochs    integer,
    ADD COLUMN IF NOT EXISTS cv_r2_valence  double precision,
    ADD COLUMN IF NOT EXISTS cv_r2_arousal  double precision,
    ADD COLUMN IF NOT EXISTS cv_mae_valence double precision,
    ADD COLUMN IF NOT EXISTS cv_mae_arousal double precision;
