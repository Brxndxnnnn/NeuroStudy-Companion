"""
features/elliptic.py

Adapter between the background worker (app/workers/feature_jobs.py) and the elliptic
band-statistics pipeline (app/feature_extraction/pipeline.py).

The worker owns scheduling, claiming and status; the pipeline owns the signal
processing. This module is the thin seam between them, and it exists to do two
things the pipeline deliberately does not.

1. MAKE THE RECOMPUTE IDEMPOTENT.
   write_elliptic_band_stats inserts with

       ON CONFLICT (session_id, time_start, channel, window_size_s) DO NOTHING

   which is safe against duplicates but is NOT an update: re-running a session at the
   same window size silently keeps the OLD values. If the filter is fixed, or a stale
   job is reclaimed and retried, the recompute would appear to succeed and change
   nothing. So this deletes the session's rows first, and the insert then writes fresh
   values into an empty slot.

2. STOP TWO WINDOW SIZES COEXISTING FOR ONE SESSION.
   window_size_s is part of that conflict key, so rows computed at 1.0 s and at 2.0 s
   do NOT collide — they ACCUMULATE. Session 1087fe73 already holds 1.0 s rows, so the
   first 2.0 s backfill would leave it holding both, at interleaved time_starts. The
   read endpoint is a bare `SELECT *` with no window filter, so the results page would
   receive both sets and silently mix two different analyses into one chart.

   The DELETE below is unqualified BY DESIGN — it removes every row for the session,
   whatever window size produced it, so exactly one analysis can exist at a time. If
   the study ever needs several window sizes side by side, that has to become a real
   feature: the endpoint must filter on window_size_s and the frontend must choose one.
   Until then, one session means one configuration.
"""

from __future__ import annotations

import logging
import os

from sqlalchemy import text

from app.feature_extraction.pipeline import run_elliptic_pipeline

log = logging.getLogger(__name__)

# 1 s window, 0.5 s step — the client's specification, matched deliberately.
#
# ⚠ One caveat to carry, not to act on: delta runs down to 0.5 Hz, which is HALF A
# CYCLE in a 1 s window. A window cannot measure a rhythm it does not contain a full
# cycle of, so delta_mean/std/peak are not really measuring delta, and theta (4 Hz, 4
# cycles) is the lowest band this window fully resolves. The other four bands are fine.
#
# Widening to 2 s would fix delta at no cost to timeline density — the STEP controls how
# many windows you get, the WINDOW controls whether each one is trustworthy — but 1 s is
# what was asked for, so 1 s is what is used. Override with ELLIPTIC_WINDOW_S if the
# delta band ever needs to be believed.
WINDOW_SIZE_S = float(os.getenv("ELLIPTIC_WINDOW_S", "1.0"))
STEP_S = float(os.getenv("ELLIPTIC_STEP_S", "0.5"))


def compute_session_features(conn, session_id: str) -> int:
    """
    Compute and store elliptic band statistics for one session.

    Called by the worker inside a transaction it owns — so this does NOT commit. A
    failure rolls back the DELETE too, which is what makes it safe to wipe the rows
    before recomputing them: a crashed run leaves the previous analysis intact rather
    than an empty table.

    Returns the number of rows written. Raises on failure (the pipeline raises
    ValueError when a session has no filtered EEG); the message reaches
    sessions.features_error and the results page.
    """
    deleted = conn.execute(
        text("DELETE FROM elliptic_band_stats WHERE session_id = :sid"),
        {"sid": session_id},
    ).rowcount

    if deleted:
        log.info("Session %s: cleared %d existing row(s) before recompute.",
                 session_id, deleted)

    result = run_elliptic_pipeline(
        conn,
        session_id,
        window_size_s=WINDOW_SIZE_S,
        step_s=STEP_S,
    )

    log.info(
        "Session %s: wrote %d row(s) at a %.1fs window / %.1fs step.",
        session_id, result["n_rows"], result["window_size_s"], result["step_s"],
    )
    return int(result["n_rows"])
