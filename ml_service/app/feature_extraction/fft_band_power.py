"""
feature_extraction/fft_band_power.py

Our OWN frequency-band powers, computed from the filtered EEG by FFT — the
replacement for trusting the SenseBand SDK's band numbers (band_powers). For each
sliding window of each channel: Welch PSD (psd.py) integrated over each band
(bandpower.py) -> absolute power in µV² for delta/theta/alpha/beta/gamma.

This mirrors the elliptic pipeline (elliptic_band_stats.py + pipeline.py) — same
gap-aware sliding windows, same fetch/compute/write split — but produces FFT POWER
(µV²) rather than elliptic-filter amplitude STATS (µV). The two are different
quantities on different tables and must never share an axis.

The output feeds the results page's "Frequency bands" chart. The chart is unchanged
(power on Y, time on X); only the source of the numbers moves from the SDK to here.
"""

from __future__ import annotations

from datetime import timedelta

import numpy as np

from app.core.config import settings
from app.data_access.queries import fetch_filtered_samples
from app.data_access.writer import write_fft_band_powers
from app.feature_extraction.bandpower import all_band_powers, BANDS
from app.feature_extraction.psd import compute_psd


def fft_band_powers_sliding(
    signals:       dict,
    times:         list,
    window_size_s: float,
    step_s:        float,
) -> list[dict]:
    """
    FFT band powers for all channels across gap-aware sliding windows.

    Args:
        signals:       {channel_name -> 1D np.ndarray} in µV (filtered).
        times:         The `time` column of the same rows the signals came from — one
                       timestamp per sample. Windows whose samples straddle a Bluetooth
                       dropout are DROPPED: they hold the right sample count but not one
                       contiguous stretch of EEG, so they are not one window. This is
                       the same guard the elliptic pipeline uses; deriving a timestamp
                       from sample index instead would drift by the total dropout.
        window_size_s: Analysis window length (s). 2 s resolves delta (0.5 Hz) — a 1 s
                       window, like the SDK's, cannot hold a full delta cycle.
        step_s:        Step between consecutive window starts (s). Smaller = denser
                       timeline / more overlap.

    Returns:
        List of window dicts in chronological order:
          {
            "time":   datetime,          -- window CENTRE (absolute, from the samples)
            "powers": { "fp1": {"delta":.., "theta":.., "alpha":.., "beta":.., "gamma":..},
                        "fp2": {...}, "t3": {...}, "t4": {...} }   -- µV²
          }
    """
    any_sig = next(iter(signals.values()))
    n       = len(any_sig)
    fs      = settings.SAMPLE_RATE

    if len(times) != n:
        raise ValueError(
            f"times has {len(times)} entries but the signals have {n} samples — "
            "they must be the same rows."
        )

    win_n  = max(1, int(round(window_size_s * fs)))
    step_n = max(1, int(round(step_s * fs)))

    # A window is contiguous iff its wall-clock span matches its sample count. Half a
    # sample of slack absorbs the µs rounding in the bridge's timestamps.
    max_span_s = (win_n - 1) / fs + 0.5 / fs

    windows = []
    for start in range(0, n - win_n + 1, step_n):
        end = start + win_n
        t0, t_last = times[start], times[end - 1]

        if (t_last - t0).total_seconds() > max_span_s:
            continue   # spans a Bluetooth dropout — not one contiguous window

        powers = {}
        for ch, sig in signals.items():
            freqs, psd = compute_psd(sig[start:end], fs=fs)
            powers[ch] = all_band_powers(freqs, psd)

        # Centre of the covered EEG. +1 sample so t_last is inclusive of its own span,
        # matching how the elliptic pipeline closes its windows.
        centre = t0 + (t_last + timedelta(seconds=1 / fs) - t0) / 2

        windows.append({"time": centre, "powers": powers})

    return windows


def run_fft_band_power_pipeline(
    conn,
    session_id:    str,
    window_size_s: float,
    step_s:        float,
) -> dict:
    """
    Full pipeline: fetch filtered EEG -> FFT band powers across sliding windows ->
    write to fft_band_powers.

    Runs inside a transaction the caller owns (does NOT commit). Raises ValueError if
    the session has no filtered samples — the message reaches sessions.features_error.

    Returns {"n_rows": int, "window_size_s": float, "step_s": float}.
    """
    samples = fetch_filtered_samples(conn, session_id)
    if not samples:
        raise ValueError(
            f"No eeg_filtered_samples found for session {session_id}. "
            "Cannot compute FFT band powers — check the bridge wrote filtered EEG."
        )

    signals = {
        ch: np.array([row[ch] for row in samples], dtype=np.float64)
        for ch in settings.CHANNELS
    }
    times = [row["time"] for row in samples]

    windows = fft_band_powers_sliding(
        signals, times, window_size_s=window_size_s, step_s=step_s
    )

    n_rows = write_fft_band_powers(
        conn,
        session_id    = session_id,
        windows       = windows,
        window_size_s = window_size_s,
        step_s        = step_s,
    )

    return {"n_rows": n_rows, "window_size_s": window_size_s, "step_s": step_s}
