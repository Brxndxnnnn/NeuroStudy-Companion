"""
Feature computations run by the background worker (app/workers/feature_jobs.py).

The worker imports its computation from the dotted path in FEATURE_COMPUTE_FN,
which defaults to:

    app.features.session_features:compute_session_features

That orchestrator runs BOTH feature sets for a completed session, inside the one
transaction the worker owns:

    elliptic.compute_session_features        -> elliptic_band_stats  (µV amplitude stats)
    fft_bandpower.compute_session_fft_band_powers -> fft_band_powers  (µV² FFT power)

The FFT band powers are our own replacement for the SenseBand SDK's band numbers
(band_powers); the results page's "Frequency bands" chart reads them instead.

Each stage is a self-contained adapter with the same contract below. Adding a third
feature set = another adapter + one line in session_features.py.

CONTRACT
--------
conn        An open SQLAlchemy connection, already inside a transaction that the
            worker commits on return and rolls back on exception. Do NOT commit it
            yourself — letting the worker own the transaction is what guarantees a
            failed run leaves no half-written feature rows behind.

returns     Number of rows written. Returning 0 is fine and is recorded as 'ready':
            a session whose electrodes were dead has no features, and that is a real
            outcome rather than a failure.

IDEMPOTENT  Required. A session WILL be recomputed — on a backfill, after a window
            size changes, or when a stale claim is reclaimed. Delete this session's
            existing rows before inserting:

                DELETE FROM elliptic_band_stats WHERE session_id = :sid

            Without this, every re-run silently doubles the rows.

RAISES      On failure. The message is stored in sessions.features_error and shown
            to whoever opens the results page, so make it worth reading.

Read the EEG from `eeg_filtered_samples` (already µV, no ADC scaling) via
app.data_access.queries.fetch_filtered_samples.
"""
