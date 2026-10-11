-- 021_remove_global_ml_model.sql
--
-- The shared (population) Phase 1 model no longer exists: every model belongs to
-- exactly one client. Remove its leftovers and make that a schema invariant.
--
-- Order matters: sessions that were last predicted by a shared model are reset first
-- (so the prediction worker re-infers them under their own client's model once one
-- exists), then the shared model rows are deleted — which cascades to their
-- session_predictions and ml_model_sessions rows — and only then can client_id be
-- made NOT NULL.
--
-- Not covered here: the shared model's .joblib files under MODEL_DIR are not touched
-- by SQL. They are unreferenced after this and can be deleted by hand.

UPDATE public.sessions
SET    predictions_status = NULL,
       predictions_error = NULL,
       predictions_model_version = NULL
WHERE  predictions_model_version IN (
           SELECT model_version FROM public.ml_models WHERE client_id IS NULL
       );

DELETE FROM public.ml_models WHERE client_id IS NULL;

DROP INDEX IF EXISTS public.ml_models_one_current_global;

ALTER TABLE public.ml_models ALTER COLUMN client_id SET NOT NULL;
