"""
feature_extraction/fft_analysis.py

FFT frequency analysis on SDK-filtered EEG data from eeg_filtered_samples.

Takes a time range (time_start_s, time_end_s) within a session, fetches the
corresponding filtered EEG samples, computes the FFT amplitude spectrum for
each channel, and displays the results from 0 Hz to 46 Hz.

Extended to 46 Hz (instead of 45 Hz) so that the gamma band upper boundary
(45 Hz) is no longer the last point in the spectrum — it has a neighbour at
45.5 Hz, which improves interpolation accuracy at that edge when downsampling
to a fixed frequency grid for DB storage.

Output: one amplitude value (µV) per frequency bin per channel, printed as
a table with columns: Frequency (Hz), FP1, FP2, T3, T4.

Usage (inside container):
    from app.database import engine
    from app.feature_extraction.fft_analysis import run_fft_analysis

    with engine.connect() as conn:
        # Specific time range
        run_fft_analysis(conn, "your-session-uuid",
                         time_start_s=0.0, time_end_s=10.0)

        # Full session
        run_fft_analysis(conn, "your-session-uuid")
"""

import numpy as np
from datetime import timedelta
from app.core.config import settings
from app.data_access.queries import (
    fetch_session,
    fetch_filtered_samples_window,
)

# Maximum frequency to display — extended 1 Hz beyond gamma upper bound (45 Hz)
# so that 45 Hz is no longer an endpoint but has a neighbour at 45.5 Hz.
FREQ_MAX = 46.0  # Hz


def compute_fft(signal: np.ndarray, fs: int) -> tuple[np.ndarray, np.ndarray]:
    """
    Compute the single-sided FFT amplitude spectrum of a 1D EEG signal.

    Args:
        signal:
            EEG signal in µV.
        fs:
            Sampling frequency (Hz).

    Returns:
        (freqs, amplitudes)
        freqs:
            Frequency bins (Hz).
        amplitudes:
            Single-sided FFT amplitude spectrum (µV), normalized using (2/N).
            The DC component (0 Hz) and Nyquist frequency (if present) are not
            doubled.
    """
    num_samples = len(signal)
    if num_samples < 2:
        raise ValueError("FFT requires at least two samples.")
    fft = np.fft.rfft(signal)
    freqs = np.fft.rfftfreq(num_samples, d=1.0 / fs)
    # Single-sided amplitude: multiply by 2 except DC (index 0) and Nyquist
    amplitudes = (2.0 / num_samples) * np.abs(fft)
    # DC component (not doubled)
    amplitudes[0] /= 2
    # Nyquist component (not doubled, only for even-length signals)
    if num_samples % 2 == 0:
        amplitudes[-1] /= 2
    return freqs, amplitudes


def run_fft_analysis(
    conn,
    session_id:   str,
    time_start_s: float = 0.0,
    time_end_s:   float = None,
    freq_max:     float = FREQ_MAX,
):
    """
    Compute the FFT amplitude spectrum (0–46 Hz) for each EEG channel within
    a specified time window.
    """
    # ----------------------------------------------------------------------
    # Step 1: Fetch session
    # ----------------------------------------------------------------------
    session = fetch_session(conn, session_id)
    if session is None:
        raise ValueError(f"Session '{session_id}' not found.")
    session_start = session["start_time"]
    fs = session.get("sample_rate") or settings.SAMPLE_RATE

    # ----------------------------------------------------------------------
    # Step 2: Determine time window
    # ----------------------------------------------------------------------
    abs_start = session_start + timedelta(seconds=time_start_s)
    if time_end_s is None:      # fetch until end of session
        abs_end = session.get("end_time")
        if abs_end is None:
            raise ValueError(
                "Session has no end_time. Please specify time_end_s."
            )
        time_end_s = (abs_end - session_start).total_seconds()
    else:
        abs_end = session_start + timedelta(seconds=time_end_s)
    if time_start_s >= time_end_s:
        raise ValueError(
            f"time_start_s ({time_start_s}s) must be less than "
            f"time_end_s ({time_end_s}s)."
        )

    # ----------------------------------------------------------------------
    # Step 3: Load filtered EEG samples
    # ----------------------------------------------------------------------
    samples = fetch_filtered_samples_window(
        conn,
        session_id,
        abs_start,
        abs_end,
    )
    if not samples:
        raise ValueError(
            f"No eeg_filtered_samples found between {time_start_s}s and "
            f"{time_end_s}s for session {session_id}."
        )
    n_samples  = len(samples)
    duration   = time_end_s - time_start_s
    resolution = fs / n_samples

    # ----------------------------------------------------------------------
    # Step 4: FFT for each EEG channel
    # ----------------------------------------------------------------------
    results = {}
    for channel in settings.CHANNELS:
        signal = np.array(
            [row[channel] for row in samples],
            dtype=np.float64,
        )
        # Remove DC offset
        signal = signal - np.mean(signal)
        freqs, amplitudes = compute_fft(signal, fs)
        results[channel] = amplitudes

    # Keep only 0–46 Hz
    mask = (freqs >= 0) & (freqs <= freq_max)
    freqs = freqs[mask]
    for channel in settings.CHANNELS:
        results[channel] = results[channel][mask]

    # ----------------------------------------------------------------------
    # Step 5: Print results
    # ----------------------------------------------------------------------
    print("\n" + "=" * 78)
    print("FFT AMPLITUDE SPECTRUM")
    print(f"Session    : {session_id}")
    print(
        f"Time Range : {time_start_s:.2f}s - {time_end_s:.2f}s "
        f"({duration:.2f}s)"
    )
    print(f"Samples    : {n_samples}")
    print(f"Sample Rate: {fs} Hz")
    print(f"Resolution : {resolution:.4f} Hz/bin")
    print(f"Frequency  : 0 - {freq_max} Hz")
    print("=" * 78)
    print(
        f"{'Freq (Hz)':>10} | "
        f"{'FP1 (µV)':>12} | "
        f"{'FP2 (µV)':>12} | "
        f"{'T3 (µV)':>12} | "
        f"{'T4 (µV)':>12}"
    )
    print("-" * 78)
    for i in range(len(freqs)):
        print(
            f"{freqs[i]:10.4f} | "
            f"{results['fp1'][i]:12.4f} | "
            f"{results['fp2'][i]:12.4f} | "
            f"{results['t3'][i]:12.4f} | "
            f"{results['t4'][i]:12.4f}"
        )
    print("=" * 78)

    return {
        "freqs":      freqs,
        "amplitudes": results,
    }


# Fixed frequency grid for DB storage — 0.0, 0.5, 1.0, ... 45.5, 46.0
# Always 93 points regardless of signal duration.
# Half-open band convention:
#   delta [0.5, 4.0)  theta [4.0, 8.0)  alpha [8.0, 13.0)
#   beta [13.0, 30.0) gamma [30.0, 45.0] buffer (45.5, 46.0]
FIXED_FREQS = np.arange(0.0, 46.5, 0.5)   # 93 points


def interpolate_to_fixed_freqs(
    freqs:      np.ndarray,
    amplitudes: dict,
) -> dict:
    """
    Resample raw FFT output to the fixed 93-point frequency grid (0-46 Hz,
    0.5 Hz steps) for DB storage.

    Raw FFT bins vary with signal duration (e.g. 1,126 bins for 10s,
    11,251 bins for 100s). Interpolating to a fixed grid gives always
    93 rows per FFT call regardless of duration, and ensures band boundary
    frequencies (4.0, 8.0, 13.0, 30.0, 45.0 Hz) are always exact points
    in the stored data — not raw bins that may be slightly offset.

    Args:
        freqs:      1D numpy array of raw FFT frequency bins (Hz),
                    from run_fft_analysis()["freqs"]. Must span 0-46 Hz.
        amplitudes: Dict {"fp1": np.ndarray, "fp2": ..., "t3": ..., "t4": ...}
                    of raw FFT amplitudes (µV) at each bin.

    Returns:
        Dict {
          "freqs":      np.ndarray,   -- FIXED_FREQS (93 points, 0-46 Hz)
          "amplitudes": {
            "fp1": np.ndarray,         -- interpolated to 93 points (µV)
            "fp2": np.ndarray,
            "t3":  np.ndarray,
            "t4":  np.ndarray,
          }
        }
    """
    return {
        "freqs": FIXED_FREQS,
        "amplitudes": {
            ch: np.interp(FIXED_FREQS, freqs, amp)
            for ch, amp in amplitudes.items()
        },
    }