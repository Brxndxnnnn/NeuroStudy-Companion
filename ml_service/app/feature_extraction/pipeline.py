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

from datetime import timedelta

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
    times:         list = None,
) -> list[dict]:
    """
    Compute elliptic band stats for all channels across sliding windows.

    Args:
        signals:       Dict {channel_name -> 1D np.ndarray} in µV.
        window_size_s: Analysis window size in seconds.
                       None = full signal as one window.
        step_s:        Step between consecutive windows in seconds.
                       None = no overlap (step equals window size).
        times:         The `time` column of the same rows the signals came from —
                       one timestamp per sample. Pass it whenever the samples came
                       from the DB. See the warning below.

    Returns:
        List of window dicts:
          {
            "time_start": datetime | float,   -- absolute if `times` was given
            "time_end":   datetime | float,
            "features":   { "fp1": {"delta": {"mean":, "std":, "peak":}, ...}, ... }
          }

    ⚠ WHY `times` MATTERS — the reason this function used to place every window in
    the wrong place.

    Sample index is NOT a clock. The bridge reconstructs a uniform 250 Hz timeline
    but leaves REAL GAPS in it where Bluetooth dropped out — the samples either side
    of a gap are adjacent in the array and seconds apart in reality. Deriving a
    window's timestamp from `index / 250` therefore drifts by the total dropout, and
    keeps drifting for the rest of the session.

    That is not a small correction. Measured against production on 15 Jul: dropout
    totals ran from 13 s to 66 s per session, so the late windows of session
    1087fe73 were landing FIFTY-ONE SECONDS from the EEG they described — attributed
    to entirely the wrong stimulus, with nothing anywhere reporting a problem.

    With `times`, a window's timestamps are read from the samples themselves, and a
    window whose samples straddle a gap is DROPPED: it holds the right number of
    samples but does not hold one contiguous window of EEG, so it is not one.

    Without `times` (synthetic signals in tests) the old offset behaviour is kept —
    there is no gap to worry about when the array is all there is.
    """
    any_sig          = next(iter(signals.values()))
    n                = len(any_sig)
    fs               = settings.SAMPLE_RATE
    total_duration_s = n / fs

    resolved_window, resolved_step = _resolve_window_step(window_size_s, step_s, total_duration_s)

    if times is None:
        # No real timeline to honour: windows are plain offsets from the array start.
        window_ranges = sliding_windows(total_duration_s, resolved_window, resolved_step)
        return [
            {
                "time_start": t0,
                "time_end":   t1,
                "features": {
                    ch: elliptical_stats_iterate(sig, (t0, t1), fs)
                    for ch, sig in signals.items()
                },
            }
            for t0, t1 in window_ranges
        ]

    if len(times) != n:
        raise ValueError(
            f"times has {len(times)} entries but the signals have {n} samples — "
            "they must be the same rows."
        )

    win_n  = max(1, int(round(resolved_window * fs)))
    step_n = max(1, int(round(resolved_step * fs)))

    # A window is contiguous iff its wall-clock span matches its sample count. Half a
    # sample of slack absorbs the µs rounding in the bridge's timestamps.
    max_span_s = (win_n - 1) / fs + 0.5 / fs

    windows = []
    for start in range(0, n - win_n + 1, step_n):
        end = start + win_n
        t0, t_last = times[start], times[end - 1]

        if (t_last - t0).total_seconds() > max_span_s:
            continue   # spans a Bluetooth dropout — not one contiguous window

        # Seconds-from-array-start, purely so elliptical_stats_iterate slices the
        # right samples. These are array coordinates, never clock time.
        slice_range = (start / fs, end / fs)

        windows.append({
            "time_start": t0,
            "time_end":   t_last + timedelta(seconds=1 / fs),
            "features": {
                ch: elliptical_stats_iterate(sig, slice_range, fs)
                for ch, sig in signals.items()
            },
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
    # The sample TIMES, carried alongside the values. Without these a window's
    # timestamp gets derived from its sample index, which silently ignores every
    # Bluetooth dropout in the session — see elliptic_sliding_multichannel.
    times = [row["time"] for row in samples]

    # ── Step 3: Resolve window parameters ────────────────────────────────────
    total_duration_s = len(next(iter(signals.values()))) / settings.SAMPLE_RATE
    resolved_window, resolved_step = _resolve_window_step(window_size_s, step_s, total_duration_s)

    # ── Step 4: Compute elliptic stats across all sliding windows ─────────────
    windows = elliptic_sliding_multichannel(
        signals,
        window_size_s = resolved_window,
        step_s        = resolved_step,
        times         = times,
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