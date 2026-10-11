-- The shared (population) model is gone: every model now belongs to one client.
-- Stop any leftover client_id IS NULL model from being flagged current. Rows and
-- artifacts are kept (metric history); nothing reads or serves them any more.
UPDATE public.ml_models
SET    is_current = false
WHERE  client_id IS NULL AND is_current;
