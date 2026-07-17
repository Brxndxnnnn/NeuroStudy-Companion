"""
features/session_features.py

The worker's single feature entrypoint. One session-complete trigger, one claim, one
transaction — but two feature sets computed inside it:

  1. elliptic band statistics  (features/elliptic.py    -> elliptic_band_stats)
  2. FFT band powers            (features/fft_bandpower.py -> fft_band_powers)

Both run in the transaction the worker owns, so a session's features are written
atomically or not at all, under the one sessions.features_status column. This is the
function FEATURE_COMPUTE_FN points at.

Ordering: elliptic first. It raises when a session has no filtered EEG, which fails
the whole session before the FFT stage — the correct outcome, since neither feature set
can be computed without EEG. If both stages succeed their row counts are summed.
"""

from __future__ import annotations

import logging

from app.features.elliptic import compute_session_features as _compute_elliptic
from app.features.fft_bandpower import compute_session_fft_band_powers

log = logging.getLogger(__name__)


def compute_session_features(conn, session_id: str) -> int:
    """
    Compute BOTH feature sets for one session and return the total rows written.

    conn is owned by the worker (do not commit). Raises on failure; the message reaches
    sessions.features_error. Idempotent — each stage clears its own table first.
    """
    elliptic_rows = _compute_elliptic(conn, session_id)
    fft_rows = compute_session_fft_band_powers(conn, session_id)

    total = elliptic_rows + fft_rows
    log.info("Session %s: %d elliptic + %d FFT = %d feature row(s).",
             session_id, elliptic_rows, fft_rows, total)
    return total
