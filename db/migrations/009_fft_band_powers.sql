-- 009_fft_band_powers.sql
--
-- Our OWN FFT-computed frequency-band powers, so the results page no longer has to
-- trust the SenseBand SDK's band numbers (band_powers). The ml_service computes these
-- from eeg_filtered_samples after a session completes — Welch PSD per window per
-- channel, integrated over each band — and the "Frequency bands" chart reads them
-- instead of the SDK values. Same chart (power on Y, time on X); different, auditable
-- source.
--
-- WHY A NEW TABLE, NOT band_powers. band_powers is the BRIDGE's table, written live
-- from the SDK. Writing our values there would interleave two producers on one time
-- axis with no column saying which is which, and the chart would plot them as one
-- series. Derived features get their own table (elliptic_band_stats is the precedent).
--
-- Columns mirror band_powers' per-channel/per-band names EXACTLY (fp1_delta … t4_gamma)
-- so the read endpoint and the frontend transform stay almost identical to the SDK
-- path — only the source table changes.
--
-- Additive only: one new table. Nothing existing is altered or dropped.

CREATE TABLE IF NOT EXISTS fft_band_powers (
    session_id     uuid        NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    -- Window CENTRE timestamp (absolute, from the samples' own clock — never derived
    -- from sample index, which ignores Bluetooth dropouts). Plotting at the centre
    -- keeps the point aligned with the EEG the window covers; a start-vs-centre mixup
    -- would shift every band point ~1 s against the event markers.
    time           timestamptz NOT NULL,
    window_size_s  real        NOT NULL,   -- provenance of the analysis window
    step_s         real        NOT NULL,
    -- FFT-computed ABSOLUTE band power (µV²) per channel. µV², like the SDK's power —
    -- NOT the µV amplitude that elliptic_band_stats holds; never share an axis with it.
    fp1_delta real, fp1_theta real, fp1_alpha real, fp1_beta real, fp1_gamma real,
    fp2_delta real, fp2_theta real, fp2_alpha real, fp2_beta real, fp2_gamma real,
    t3_delta  real, t3_theta  real, t3_alpha  real, t3_beta  real, t3_gamma  real,
    t4_delta  real, t4_theta  real, t4_alpha  real, t4_beta  real, t4_gamma  real,
    PRIMARY KEY (session_id, time)
);

SELECT create_hypertable('fft_band_powers', by_range('time'), if_not_exists => TRUE);
SELECT set_chunk_time_interval('fft_band_powers', INTERVAL '1 day');

-- ml_service (writes) connects as a table-owning / BYPASSRLS role; the backend (reads)
-- connects as APP_DB_USER. Grant explicitly so the source table is accessible whichever
-- of the known roles each side uses — mirrors the eeg_filtered_samples grant pattern.
GRANT SELECT, INSERT, UPDATE, DELETE ON fft_band_powers TO bridge_writer;
GRANT SELECT                        ON fft_band_powers TO app_user;
