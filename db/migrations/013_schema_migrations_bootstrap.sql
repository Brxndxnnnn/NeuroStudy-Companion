-- Tracks which files in db/migrations/ have been applied, so db/migrate.sh can
-- safely apply only what's new instead of requiring a human to remember by hand.
-- Backfills every migration that predates this table with its already-known,
-- already-applied filename, WITHOUT re-running any of them.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (filename) VALUES
  ('001_init.sql'),
  ('002_create_bridge_user.sh'),
  ('003_dev_seed.sql'),
  ('004_eeg_raw_samples.sql'),
  ('005_functions_and_updates.sql'),
  ('006_oasis_labels_image_sets_feature_jobs.sql'),
  ('007_ml_phase1_models_predictions.sql'),
  ('008_prediction_ground_truth.sql'),
  ('009_fft_band_powers.sql'),
  ('010_database_roles.sql'),
  ('011_seed_bridge_placeholders.sql'),
  ('012_per_client_models.sql'),
  ('013_schema_migrations_bootstrap.sql')
ON CONFLICT (filename) DO NOTHING;
