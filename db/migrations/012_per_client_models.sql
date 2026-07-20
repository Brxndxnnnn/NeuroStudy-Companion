-- 012_per_client_models.sql
--
-- Per-user (per-client) Phase 1 models, alongside the existing population model.
--
-- WHY: EEG is highly individualistic — cap fit, skull, cortical folding and
-- individual alpha frequency vary more between people than the stimulus effect the
-- model is trying to read. A model fitted to one client's own recordings does not
-- have to survive that variation. The population model stays: it is what a brand
-- new client is served until they have recordings of their own.
--
-- Additive only: one nullable column, one new table, and a swap of the
-- one-current-model index for a pair that scopes the same guarantee per client.
-- Nothing existing is dropped and no data is rewritten, so this is safe to apply
-- to the live database while the workers are running.
--
-- No row-level security here, for the same reason as migration 007: ml_service
-- connects as a BYPASSRLS role and would bypass any policy anyway.

-- ── Whose model is this? ─────────────────────────────────────────────────────
-- NULL  = the population model, trained on every client's data (the weekly cron).
-- Set   = a personal model, trained only on that client's own sessions.
--
-- Nullable rather than NOT NULL with a sentinel, so "belongs to everyone" and
-- "belongs to this person" stay genuinely distinct states that the partial indexes
-- below can key off.
ALTER TABLE ml_models
    ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(client_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ml_models_client ON ml_models (client_id);

-- ── One current model PER SCOPE ──────────────────────────────────────────────
-- Migration 007 enforced a single current model globally. With personal models
-- that is wrong: the population model and each client's own model must be able to
-- be current simultaneously. Replace it with two partial unique indexes that give
-- the same "never two current, never a promotion race" guarantee within each scope.
DROP INDEX IF EXISTS ml_models_one_current;

CREATE UNIQUE INDEX IF NOT EXISTS ml_models_one_current_global
    ON ml_models (is_current) WHERE is_current AND client_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ml_models_one_current_per_client
    ON ml_models (client_id) WHERE is_current AND client_id IS NOT NULL;

-- ── Which sessions trained this model ────────────────────────────────────────
-- The technician chooses which of a client's sessions to train from — necessary,
-- because a session with a dead electrode teaches the model nothing useful.
--
-- But choosing sessions AFTER seeing results is selection bias: pick the ones that
-- flatter the model and the reported accuracy is inflated. ml_models.n_sessions
-- only records a count, which cannot answer "which ones, and why those?" months
-- later. This table makes every training set auditable and therefore defensible.
CREATE TABLE IF NOT EXISTS ml_model_sessions (
    model_version integer NOT NULL REFERENCES ml_models(model_version) ON DELETE CASCADE,
    session_id    uuid    NOT NULL REFERENCES sessions(session_id)     ON DELETE CASCADE,
    PRIMARY KEY (model_version, session_id)
);

CREATE INDEX IF NOT EXISTS ml_model_sessions_session ON ml_model_sessions (session_id);
