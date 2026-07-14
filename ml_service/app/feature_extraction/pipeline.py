"""
feature_extraction/pipeline.py

Orchestrates the full elliptic feature extraction pipeline for one session:

  1. Fetch SDK-filtered EEG from eeg_filtered_samples
  2. Compute elliptic band stats across sliding windows (all channels, all bands)
  3. Write results to elliptic_band_stats table

Called by api/process.py (/process endpoint) after a session ends.
It wires together data_access/queries.py, elliptic_band_stats.py, and
data_access/writer.py — none of those modules know about each other.

Note: this is intentionally separate from the ML inference pipeline
(api/infer.py). This pipeline computes and stores features;
/infer loads those features and runs ML models on top of them.

To change the DEFAULT window/step size (used when a caller passes
None), edit ELLIPTIC_WINDOW_SIZE_S / ELLIPTIC_STEP_S in
app/core/config.py. Passing window_size_s/step_s explicitly
(e.g. via the /process endpoint) always overrides that default.

Usage:
    from app.database import engine
    from app.feature_extraction.pipeline import run_elliptic_pipeline

    with engine.begin() as conn:
        result = run_elliptic_pipeline(
            conn,
            session_id    = "your-session-uuid",
            window_size_s = 2.0,   # None = full signal as one window
            step_s        = 1.0,   # None = no overlap
        )
        print(f"Inserted {result['n_rows']} rows into elliptic_band_stats")
"""

import numpy as np

from app.core.config import settings
from app.data_access.queries import fetch_filtered_samples
from app.data_access.writer import write_elliptic_band_stats
from app.feature_extraction.elliptic_band_stats import (
    elliptical_stats_iterate,
    sliding_windows,
)


def _resolve_window_step(window_size_s: float, step_s: float, total_duration_s: float) -> tuple[float, float]:
    """
    Resolve window_size_s/step_s: explicit value -> settings.ELLIPTIC_*
    default (config.py) -> full signal as one window.
    """
    resolved_window = window_size_s
    if resolved_window is None:
        resolved_window = settings.ELLIPTIC_WINDOW_SIZE_S
    if resolved_window is None:
        resolved_window = total_duration_s   # no config default set -> full signal

    resolved_step = step_s
    if resolved_step is None:
        resolved_step = settings.ELLIPTIC_STEP_S
    if resolved_step is None:
        resolved_step = resolved_window      # no config default set -> no overlap

    return resolved_window, resolved_step


def elliptic_sliding_multichannel(
    signals:       dict,
    window_size_s: float = None,
    step_s:        float = None,
) -> list[dict]:
    """
    Compute elliptic band stats for all channels across sliding windows.

    Extracted as a standalone public function so both run_elliptic_pipeline()
    and test_features.py can use the same implementation without duplication.

    Args:
        signals:       Dict {channel_name -> 1D np.ndarray} in µV.
        window_size_s: Analysis window size in seconds.
                       None = full signal as one window.
        step_s:        Step between consecutive windows in seconds.
                       None = no overlap (step equals window size).

    Returns:
        List of window dicts, one per window:
          {
            "time_start": float,   -- seconds from signal start
            "time_end":   float,   -- seconds from signal start
            "features": {
              "fp1": {"delta": {"mean":, "std":, "peak":}, ...},
              "fp2": {...}, "t3": {...}, "t4": {...},
            }
          }
    """
    any_sig          = next(iter(signals.values()))
    total_duration_s = len(any_sig) / settings.SAMPLE_RATE

    resolved_window, resolved_step = _resolve_window_step(window_size_s, step_s, total_duration_s)

    window_ranges = sliding_windows(total_duration_s, resolved_window, resolved_step)

    windows = []
    for time_start, time_end in window_ranges:
        features = {
            ch: elliptical_stats_iterate(
                sig, (time_start, time_end), settings.SAMPLE_RATE
            )
            for ch, sig in signals.items()
        }
        windows.append({
            "time_start": time_start,
            "time_end":   time_end,
            "features":   features,
        })

    return windows


def run_elliptic_pipeline(
    conn,
    session_id:    str,
    window_size_s: float = None,
    step_s:        float = None,
) -> dict:
    """
    Full pipeline: fetch SDK-filtered EEG -> compute elliptic band stats
    -> write results to elliptic_band_stats table.

    Args:
        conn:          Open SQLAlchemy connection with an active transaction
                       (use engine.begin(), not engine.connect(), so the
                       write is committed or rolled back atomically).
        session_id:    UUID string of the session to process.
        window_size_s: Analysis window size in seconds.
                       None (default) = treat the full session as one window.
        step_s:        Step between consecutive windows in seconds.
                       None (default) = no overlap (step equals window size).

    Returns:
        Dict with the resolved values actually used and stored in the DB:
          {
            "n_rows":        int,    -- rows written to elliptic_band_stats
            "window_size_s": float,  -- resolved window size (never None)
            "step_s":        float,  -- resolved step (never None)
          }

    Raises:
        ValueError: If no eeg_filtered_samples exist for the session,
                    or if the session itself is not found.
    """
    # ── Step 1: Fetch SDK-filtered samples ────────────────────────────────────
    samples = fetch_filtered_samples(conn, session_id)
    if not samples:
        raise ValueError(
            f"No eeg_filtered_samples found for session {session_id}. "
            f"Cannot run elliptic pipeline — check the bridge is writing "
            f"filtered samples for this session."
        )

    # ── Step 2: Build per-channel signal arrays (µV, 1D numpy) ───────────────
    signals = {
        ch: np.array([row[ch] for row in samples], dtype=np.float64)
        for ch in settings.CHANNELS
    }

    # ── Step 3: Resolve window parameters ────────────────────────────────────
    total_duration_s = len(next(iter(signals.values()))) / settings.SAMPLE_RATE
    resolved_window, resolved_step = _resolve_window_step(window_size_s, step_s, total_duration_s)

    # ── Step 4: Compute elliptic stats across all sliding windows ─────────────
    windows = elliptic_sliding_multichannel(
        signals,
        window_size_s = resolved_window,
        step_s        = resolved_step,
    )

    # ── Step 5: Write to DB ───────────────────────────────────────────────────
    n_rows = write_elliptic_band_stats(
        conn,
        session_id    = session_id,
        windows       = windows,
        window_size_s = resolved_window,
        step_s        = resolved_step,
    )

    return {
        "n_rows":        n_rows,
        "window_size_s": resolved_window,
        "step_s":        resolved_step,
    }