"""
Feature computations run by the background worker (app/workers/feature_jobs.py).

The worker imports its computation from the dotted path in FEATURE_COMPUTE_FN,
which defaults to:

    app.features.elliptic:compute_session_features

THAT MODULE DOES NOT EXIST YET — it is Zhengda's elliptic band-statistics code,
which currently lives outside the repo. Until it does, the worker logs a warning at
startup and does not schedule itself. It deliberately does NOT run with a stub: a
stub would claim every completed session and mark it 'failed', which is worse than
not running.

To wire it up, create app/features/elliptic.py with:

    def compute_session_features(conn, session_id: str) -> int:
        ...
        return rows_written

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
