"""
data_access/phase1_status.py

Fast, aggregate-only readiness queries for the ML Phase 1 dashboard (the web
Insights tab). Deliberately does NOT touch eeg_filtered_samples row-by-row — that
is tens of thousands of rows per session and belongs to the offline pipeline
(scripts/run_phase1.py). Everything here is a COUNT the DB answers instantly, so
the endpoint is safe to hit on a page load.

The one thing worth knowing about the joins: an image counts toward training only
if it is BOTH OASIS-labelled (images.valence_mean IS NOT NULL) AND was shown in a
completed session that actually recorded filtered EEG. A labelled image nobody
looked at, or an image shown in a session with no EEG, contributes no training row.
"""

from sqlalchemy import text


def phase1_readiness(conn) -> dict:
    """
    One round-trip's worth of counts describing how close Phase 1 is to having
    enough real data to train on. See the module docstring for the join logic.
    """
    row = conn.execute(text("""
        WITH labelled_eeg_events AS (
            -- Image events, in completed sessions that recorded filtered EEG,
            -- whose image carries an OASIS label. This is the raw material every
            -- training epoch is cut from.
            SELECT e.session_id, e.image_id
            FROM   events   e
            JOIN   images   i ON i.image_id   = e.image_id
            JOIN   sessions s ON s.session_id = e.session_id
            WHERE  i.valence_mean IS NOT NULL
              AND  e.hidden_at    IS NOT NULL
              AND  s.sync_status  = 'completed'
              AND  EXISTS (
                     SELECT 1 FROM eeg_filtered_samples f
                     WHERE  f.session_id = e.session_id
                   )
        )
        SELECT
            (SELECT count(*) FROM sessions WHERE sync_status = 'completed')
                AS sessions_completed,
            (SELECT count(*) FROM images WHERE valence_mean IS NOT NULL)
                AS oasis_images_labelled,
            (SELECT count(*) FROM labelled_eeg_events)
                AS labelled_image_events,
            (SELECT count(DISTINCT image_id)   FROM labelled_eeg_events)
                AS distinct_labelled_images,
            (SELECT count(DISTINCT session_id) FROM labelled_eeg_events)
                AS sessions_with_oasis_eeg
    """)).mappings().first()

    return dict(row) if row else {}
