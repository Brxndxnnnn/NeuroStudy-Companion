"""
features/fft_bandpower.py

Adapter between the background worker and the FFT band-power pipeline
(app/feature_extraction/fft_band_power.py) — the sibling of features/elliptic.py.

It exists to make the recompute idempotent: the pipeline INSERTs (ON CONFLICT DO
UPDATE), but that alone cannot remove rows a shorter recompute no longer produces. So
this DELETEs the session's rows first — unqualified by window size, exactly as the
elliptic adapter does, so one session holds exactly one configuration and the read
endpoint never hands the chart two analyses at once.

Does not commit — the worker owns the transaction.
"""

from __future__ import annotations

import logging
import os

from sqlalchemy import text

from app.feature_extraction.fft_band_power import run_fft_band_power_pipeline

log = logging.getLogger(__name__)

# 2 s window / 0.5 s step. Unlike the SDK's 1 s window, 2 s holds a full delta cycle
# (0.5 Hz), so every band is actually resolved; 0.5 s step gives a dense timeline.
# Override with FFT_BANDPOWER_WINDOW_S / FFT_BANDPOWER_STEP_S.
WINDOW_SIZE_S = float(os.getenv("FFT_BANDPOWER_WINDOW_S", "2.0"))
STEP_S        = float(os.getenv("FFT_BANDPOWER_STEP_S", "0.5"))


def compute_session_fft_band_powers(conn, session_id: str) -> int:
    """
    Compute and store our FFT band powers for one session. Returns rows written; raises
    (via the pipeline) if the session has no filtered EEG. Idempotent: clears the
    session's rows before recomputing, so the DELETE rolls back with the pipeline on
    failure and the previous analysis survives.
    """
    deleted = conn.execute(
        text("DELETE FROM fft_band_powers WHERE session_id = :sid"),
        {"sid": session_id},
    ).rowcount

    if deleted:
        log.info("Session %s: cleared %d existing FFT band-power row(s) before recompute.",
                 session_id, deleted)

    result = run_fft_band_power_pipeline(
        conn, session_id, window_size_s=WINDOW_SIZE_S, step_s=STEP_S
    )

    log.info(
        "Session %s: wrote %d FFT band-power row(s) at a %.1fs window / %.1fs step.",
        session_id, result["n_rows"], result["window_size_s"], result["step_s"],
    )
    return int(result["n_rows"])
