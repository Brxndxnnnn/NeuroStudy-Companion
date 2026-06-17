"""
preprocessing/pipeline.py

Full preprocessing pipeline for one session.

Data flow:
  1. Fetch eeg_readings frame rows           → quality gate
  2. Identify clean time windows             → get_good_time_windows()
  3. Fetch eeg_raw_samples for each window   → convert ADC counts to µV
  4. Apply bandpass filter                   → 0.5–45 Hz
  5. Apply notch filter                      → remove 50 Hz mains
  6. Return cleaned signal arrays + metadata → ready for FFT

Output dict structure:
  {
    "windows": [
      {
        "start":   datetime,
        "end":     datetime,
        "signals": {"fp1": np.ndarray, "fp2": ..., "t3": ..., "t4": ...},
                    # arrays in µV, 250 Hz, length ≈ WINDOW_SIZE_S * 250
      },
      ...
    ],
    "quality_report":  dict,         # from quality.py
    "n_windows":       int,
    "n_rejected_frames": int,
    "session_id":      str,
  }

Usage:
    from app.database import engine
    from app.preprocessing.pipeline import run_pipeline

    with engine.connect() as conn:
        result = run_pipeline(conn, session_id="<uuid>")
"""

import numpy as np
from app.core.config import settings
from app.data_access.queries import fetch_eeg_readings, fetch_raw_samples_window
from app.preprocessing.quality import gate_frames, get_good_time_windows, quality_report
from app.preprocessing.bandpass import apply_bandpass_multichannel
from app.preprocessing.notch import apply_notch_multichannel


# ADC integer counts -> microvolts
ADC_SCALE = settings.ADC_SCALE


def _adc_to_uv(samples: list[dict]) -> dict:
    """
    Convert raw ADC integer samples to µV arrays per channel.

    Args:
        samples: List of dicts with keys fp1, fp2, t3, t4 (integers).

    Returns:
        Dict {"fp1": np.ndarray, "fp2": ..., "t3": ..., "t4": ...} in µV.
    """
    result = {}
    for ch in settings.CHANNELS:
        counts = np.array([row[ch] for row in samples], dtype=np.float64)
        result[ch] = counts * ADC_SCALE
    return result


def run_pipeline(
    conn,
    session_id:       str,
    bandpass_kwargs:  dict = None,
    notch_kwargs:     dict = None,
    quality_kwargs:   dict = None,
) -> dict:
    """
    Run the full preprocessing pipeline for one session.

    Args:
        conn:             Open SQLAlchemy connection.
        session_id:       UUID string of the session to process.
        bandpass_kwargs:  Optional overrides for bandpass filter params.
        notch_kwargs:     Optional overrides for notch filter params.
        quality_kwargs:   Optional overrides for quality gate thresholds.

    Returns:
        Preprocessing result dict (see module docstring for structure).

    Raises:
        ValueError: If no eeg_readings exist or all frames are rejected.
    """
    bandpass_kwargs = bandpass_kwargs or {}
    notch_kwargs    = notch_kwargs    or {}
    quality_kwargs  = quality_kwargs  or {}

    # ── Step 1: Fetch frame summaries for quality gating ──────────────────────
    frame_rows = fetch_eeg_readings(conn, session_id)
    if not frame_rows:
        raise ValueError(
            f"No eeg_readings found for session {session_id}. "
            f"Cannot run quality gate."
        )

    # ── Step 2: Quality gate ───────────────────────────────────────────────────
    accepted_frames, rejected_frames, gate_results = gate_frames(
        frame_rows, **quality_kwargs
    )
    q_report = quality_report(gate_results)

    if not accepted_frames:
        raise ValueError(
            f"All {len(frame_rows)} frames rejected by quality gate for "
            f"session {session_id}. Check electrode connection."
        )

    # ── Step 3: Identify clean time windows ───────────────────────────────────
    clean_windows = get_good_time_windows(accepted_frames)
    if not clean_windows:
        raise ValueError(
            f"No complete clean windows found for session {session_id}. "
            f"Too many rejected frames or session too short."
        )

    # ── Steps 4–6: Fetch raw samples, convert, filter — per window ────────────
    processed_windows = []

    for window_start, window_end in clean_windows:
        # Fetch raw ADC samples for this window from eeg_raw_samples
        raw_rows = fetch_raw_samples_window(
            conn, session_id, window_start, window_end
        )

        if not raw_rows:
            # Window had clean quality frames but no raw samples — skip
            continue

        # Convert ADC counts to µV
        signals_uv = _adc_to_uv(raw_rows)

        # Bandpass: 0.5–45 Hz
        try:
            bandpassed = apply_bandpass_multichannel(signals_uv, **bandpass_kwargs)
        except ValueError:
            # Window too short for filter — skip
            continue

        # Notch: 50 Hz + 100 Hz harmonic
        filtered = apply_notch_multichannel(bandpassed, **notch_kwargs)

        processed_windows.append({
            "start":   window_start,
            "end":     window_end,
            "signals": filtered,      # µV, bandpassed + notch filtered
        })

    if not processed_windows:
        raise ValueError(
            f"No processable windows produced for session {session_id}. "
            f"Check that eeg_raw_samples is populated."
        )

    return {
        "session_id":        session_id,
        "windows":           processed_windows,
        "n_windows":         len(processed_windows),
        "quality_report":    q_report,
        "n_rejected_frames": len(rejected_frames),
    }