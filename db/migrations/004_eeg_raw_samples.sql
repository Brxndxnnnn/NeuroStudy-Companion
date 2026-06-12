-- 004_eeg_raw_samples.sql
-- Full-resolution raw EEG for ML consumption.
--
-- Unlike eeg_readings (a ~2 Hz last/peak-to-peak SUMMARY), this table stores
-- EVERY sample the SenzeBand emits: 250 samples/sec/channel, 24-bit ADC counts.
-- The bridge (bridge_writer) bulk-COPYs into it; the ML service reads from it.
--
-- Channels are the 4 SenzeBand EEG positions. Values are raw ADC counts:
--   microvolts = count * 0.02235   (24-bit, ±187.5 mVpp input range)
--
-- No RLS here, matching eeg_readings / band_powers — tenant isolation is enforced
-- at the sessions level. Do NOT add an RLS policy.

CREATE TABLE eeg_raw_samples (
    session_id uuid        NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    time       timestamptz NOT NULL,   -- per-sample time, derived on the DB clock at 250 Hz
    fp1        integer,
    fp2        integer,
    t3         integer,
    t4         integer,
    PRIMARY KEY (session_id, time)
);

SELECT create_hypertable('eeg_raw_samples', by_range('time'));
SELECT set_chunk_time_interval('eeg_raw_samples', INTERVAL '1 day');

-- bridge_writer (BYPASSRLS) must be able to COPY/INSERT; app_user reads later.
-- If this migration is run by the same superuser that ran 002_create_bridge_user.sh,
-- the ALTER DEFAULT PRIVILEGES there already covers these — kept explicit for safety.
GRANT SELECT, INSERT ON eeg_raw_samples TO bridge_writer;
GRANT SELECT            ON eeg_raw_samples TO app_user;
