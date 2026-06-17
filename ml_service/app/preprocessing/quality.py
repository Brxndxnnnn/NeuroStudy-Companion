"""
preprocessing/quality.py

Signal quality gating based on eeg_readings frame summaries.

eeg_raw_samples holds every sample but has no quality signal.
eeg_readings holds per-frame filt_pkpk values that reflect the
SenzeBand's own signal quality assessment — we use these to identify
time windows that are too noisy or flat before running FFT.

Two rejection conditions per channel per frame:
  1. filt_pkpk > QUALITY_PKPK_MAX  →  movement / EMG artefact
  2. filt_pkpk < QUALITY_PKPK_MIN  →  flat line (electrode off / saturated)

A time window (covering WINDOW_SIZE_S seconds) is accepted only if
ALL channels in ALL frames within that window pass both checks.
"""

import numpy as np
from dataclasses import dataclass, field
from typing import Optional
from app.core.config import settings


@dataclass
class FrameQuality:
    """Quality gate result for one eeg_readings frame."""
    time:          object              # datetime of the frame
    accepted:      bool
    reason:        Optional[str]       # None if accepted
    channel_flags: dict = field(default_factory=dict)   # ch -> "ok"|"high_noise"|"flat_line"


def check_frame(
    row:       dict,
    pkpk_max:  float = None,
    pkpk_min:  float = None,
) -> FrameQuality:
    """
    Check one eeg_readings frame row.

    Args:
        row:      Dict with keys fp1_filt_pkpk, fp2_filt_pkpk,
                  t3_filt_pkpk, t4_filt_pkpk, time.
        pkpk_max: Artefact ceiling (µV). Defaults to settings value.
        pkpk_min: Flat-line floor (µV). Defaults to settings value.

    Returns:
        FrameQuality dataclass.
    """
    pkpk_max = pkpk_max or settings.QUALITY_PKPK_MAX
    pkpk_min = pkpk_min or settings.QUALITY_PKPK_MIN

    pkpk_map = {
        "fp1": row.get("fp1_filt_pkpk"),
        "fp2": row.get("fp2_filt_pkpk"),
        "t3":  row.get("t3_filt_pkpk"),
        "t4":  row.get("t4_filt_pkpk"),
    }

    flags   = {}
    reasons = []

    for ch, val in pkpk_map.items():
        if val is None or (isinstance(val, float) and np.isnan(val)):
            flags[ch] = "missing"
            reasons.append(f"{ch}: missing")
        elif val > pkpk_max:
            flags[ch] = "high_noise"
            reasons.append(f"{ch}: pk-pk {val:.1f} > {pkpk_max} µV")
        elif val < pkpk_min:
            flags[ch] = "flat_line"
            reasons.append(f"{ch}: pk-pk {val:.1f} < {pkpk_min} µV")
        else:
            flags[ch] = "ok"

    accepted = len(reasons) == 0
    return FrameQuality(
        time=row.get("time"),
        accepted=accepted,
        reason="; ".join(reasons) if reasons else None,
        channel_flags=flags,
    )


def gate_frames(frame_rows: list, **kwargs) -> tuple:
    """
    Apply quality gate to a list of eeg_readings frame rows.

    Args:
        frame_rows: List of dicts from fetch_eeg_readings().
        **kwargs:   Forwarded to check_frame.

    Returns:
        (accepted_rows, rejected_rows, quality_results)
        where accepted_rows and rejected_rows are subsets of frame_rows.
    """
    results  = [check_frame(row, **kwargs) for row in frame_rows]
    accepted = [frame_rows[i] for i, r in enumerate(results) if r.accepted]
    rejected = [frame_rows[i] for i, r in enumerate(results) if not r.accepted]
    return accepted, rejected, results


def get_good_time_windows(
    accepted_frames: list,
    window_size_s:   int   = None,
) -> list[tuple]:
    """
    Convert accepted frame timestamps to (start, end) time windows
    for slicing eeg_raw_samples in the preprocessing pipeline.

    Each accepted frame covers ~1 second. We group consecutive accepted
    frames into windows of window_size_s seconds. A window is only included
    if it is fully covered by accepted frames (no gaps).

    Args:
        accepted_frames: List of accepted frame dicts (must have 'time' key).
        window_size_s:   Window length in seconds. Defaults to settings.WINDOW_SIZE_S.

    Returns:
        List of (start_datetime, end_datetime) tuples for clean windows.
    """
    from datetime import timedelta

    window_size_s = window_size_s or settings.WINDOW_SIZE_S

    if not accepted_frames:
        return []

    times = sorted(row["time"] for row in accepted_frames)
    windows = []
    i = 0

    while i < len(times):
        window_start = times[i]
        window_end   = window_start + timedelta(seconds=window_size_s)

        # Count how many accepted frames fall within this window
        frames_in_window = [t for t in times[i:] if t < window_end]

        # Only keep window if fully covered (at least window_size_s frames)
        if len(frames_in_window) >= window_size_s:
            windows.append((window_start, window_end))
            i += window_size_s   # advance by full window (non-overlapping for quality)
        else:
            i += 1

    return windows


def quality_report(results: list) -> dict:
    """
    Summarise quality gate results.

    Returns:
        Dict with total, accepted, rejected counts and rejection rate.
    """
    total    = len(results)
    accepted = sum(1 for r in results if r.accepted)
    return {
        "total_frames":    total,
        "accepted_frames": accepted,
        "rejected_frames": total - accepted,
        "rejection_rate":  round((total - accepted) / total, 4) if total else 0.0,
    }