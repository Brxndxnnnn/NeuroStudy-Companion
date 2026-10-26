-- 027: Group training runs in the background (26 Oct 2026).
--
-- Training a group fits a forest for every person x image block x with/without BFI, so it
-- takes minutes and grows with every member. Run inside the HTTP request, it outlived the
-- proxy's timeout and the page reported "Training failed" while the model was in fact
-- still being trained. ml_service now starts training in the background and records its
-- progress on the group, where the page can read it and keep showing "Training…".
--
--   train_status       running | done | failed (NULL: never trained this way)
--   train_started_at   when the current/last run started; also identifies the run, so a
--                      run that was overtaken never overwrites its successor's result
--   train_finished_at  when it ended
--   train_result       done: what training returned (trained, message, skipped, scores)
--   train_error        failed: what went wrong
--
-- Written by ml_service (BYPASSRLS); read by the backend under the existing RLS policy.
-- Additive only. Safe to re-run.

ALTER TABLE public.ml_groups
    ADD COLUMN IF NOT EXISTS train_status      text
        CHECK (train_status IN ('running', 'done', 'failed')),
    ADD COLUMN IF NOT EXISTS train_started_at  timestamptz,
    ADD COLUMN IF NOT EXISTS train_finished_at timestamptz,
    ADD COLUMN IF NOT EXISTS train_result      jsonb,
    ADD COLUMN IF NOT EXISTS train_error       text;
