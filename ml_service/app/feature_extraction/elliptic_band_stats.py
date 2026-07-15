"""
feature_extraction/elliptic_band_stats.py

Per-band and multi-band time-domain statistics (mean, std, peak) from
elliptic (Cauer) bandpass filtering.

Functions:
  elliptical_stats(freq_band, signal, time_range) -> {"mean":, "std":, "peak":}
      One frequency band on one channel's signal, one time window.
  elliptical_stats_iterate(signal, time_range) -> {"delta": {...}, ..., "gamma": {...}}
      Runs elliptical_stats() once per standard band (delta/theta/alpha/beta/gamma),
      5 bands x 3 stats = 15 datapoints total.
  sliding_windows(total_duration_s, window_size_s, step_s) -> [(time_start, time_end), ...]
      Pure time-window generator, used by elliptical_stats_sliding().
  elliptical_stats_sliding(freq_band, signal, window_size_s, step_s) -> [dict, ...]
      Runs elliptical_stats() for one band across every sliding window of a
      full signal, so a longer fetched array can be scanned in overlapping
      chunks without a separate DB fetch per window.
      window_size_s=None -> full signal as one window (no slicing).
      step_s=None        -> defaults to window_size_s (no overlap).

Filter design notes:
  ELLIPTIC_ORDER=6, ELLIPTIC_RP=0.05 dB, ELLIPTIC_RS=60 dB.
  sosfiltfilt applies the filter forward AND backward for zero phase delay,
  which SQUARES the filter's magnitude response. A larger passband ripple
  (rp) means the gain at some in-band frequencies dips below 1.0, and after
  squaring, that dip is doubled — e.g. rp=1dB (an earlier version of this
  filter) let gain dip to ~0.90 at some in-band frequencies, so 0.90^2 ~= 0.81,
  a ~19% understatement of true signal amplitude/std. Dropping rp to 0.05dB
  and raising the order to 6 (compensating for the sharper cutoff a low-rp
  elliptic filter needs) keeps the passband response within ~2% of unity
  across all 5 bands while still cleanly separating adjacent bands
  (verified: >50x rejection of a sine one band over).

Frequency bands are read directly from settings.BAND_DELTA / BAND_THETA /
BAND_ALPHA / BAND_BETA / BAND_GAMMA — settings.py is the single source of
truth for band edges. The filter-builder (design_elliptic_bandpass) takes a band
NAME, not raw frequencies, and looks the edges up itself — it is not meant
to be reused for arbitrary/custom frequency ranges.
"""

import numpy as np
from scipy.signal import ellip, sosfiltfilt
from app.core.config import settings

# Standard elliptic filter design parameters.
# rp: max ripple allowed in the passband (dB) — lower = flatter passband.
# rs: min attenuation required in the stopband (dB) — higher = sharper cutoff.
ELLIPTIC_ORDER = 6
ELLIPTIC_RP    = 0.05   # dB — max passband ripple
ELLIPTIC_RS    = 60     # dB — min stopband attenuation

# Band name -> (low_hz, high_hz)
BAND_EDGES = {
    "delta": settings.BAND_DELTA,
    "theta": settings.BAND_THETA,
    "alpha": settings.BAND_ALPHA,
    "beta":  settings.BAND_BETA,
    "gamma": settings.BAND_GAMMA,
}


def design_elliptic_bandpass(freq_band: str, fs: int):
    """
    Build an elliptic bandpass filter as second-order sections for one of
    the standard bands, using cutoffs from BAND_EDGES (i.e. settings.BAND_*).

    Raises:
        KeyError:   If freq_band is not a recognised band name.
        ValueError: If the band's frequency range is invalid for this sample rate.
    """
    if freq_band not in BAND_EDGES:
        raise KeyError(
            f"Unknown freq_band '{freq_band}'. Must be one of {list(BAND_EDGES)}."
        )

    start_freq, end_freq = BAND_EDGES[freq_band]
    nyq  = fs / 2.0
    low  = start_freq / nyq
    high = end_freq   / nyq

    if not (0 < low < high < 1):
        raise ValueError(
            f"Invalid band range for '{freq_band}': {start_freq}-{end_freq} Hz "
            f"at {fs} Hz sample rate. Normalised: {low:.3f}-{high:.3f} "
            f"(must be strictly between 0 and 1)."
        )

    return ellip(ELLIPTIC_ORDER, ELLIPTIC_RP, ELLIPTIC_RS, [low, high],
                 btype="bandpass", output="sos")


def elliptical_stats(
    freq_band:  str,
    signal:     np.ndarray,
    time_range: tuple,
    fs:         int = None,
) -> dict:
    """
    Isolate one frequency band within a time window and compute mean,
    standard deviation, and peak amplitude of the filtered waveform.

    Args:
        freq_band:  Band name — one of "delta", "theta", "alpha", "beta", "gamma".
        signal:     1D numpy array of EEG samples (uV) for ONE channel — the
                    FULL signal; time_range slices into it. time_range is in
                    seconds relative to the start of THIS array (index 0),
                    not a database timestamp.
        time_range: (time_start, time_end) tuple in seconds, exclusive end.
        fs:         Sampling rate (Hz) of the signal array. Defaults to settings.SAMPLE_RATE.

    Returns:
        {"mean": float, "std": float, "peak": float} — "peak" is the maximum absolute
        amplitude (µV), capturing the largest excursion in either direction.

    Raises:
        KeyError:   If freq_band is not a recognised band name.
        ValueError: If the time window is invalid, out of range, or too short for the filter.
    """
    fs  = fs or settings.SAMPLE_RATE
    sos = design_elliptic_bandpass(freq_band, fs)

    time_start, time_end = time_range
    signal = np.asarray(signal, dtype=np.float64)
    total_duration_s = len(signal) / fs

    if time_start < 0 or time_end > total_duration_s or time_start >= time_end:
        raise ValueError(
            f"Invalid time window [{time_start}, {time_end})s for a signal of "
            f"{total_duration_s:.2f}s duration."
        )

    start_idx = int(round(time_start * fs))
    end_idx   = int(round(time_end   * fs))
    window    = signal[start_idx:end_idx]

    # sosfiltfilt's default padlen is 3 * (2 * n_sections + 1); it requires
    # length > padlen, so derive min_len from the actual filter instead of a
    # hardcoded formula (n_sections isn't guaranteed to equal ELLIPTIC_ORDER).
    padlen  = 3 * (2 * sos.shape[0] + 1)
    min_len = padlen + 1
    if len(window) < min_len:
        raise ValueError(
            f"Window too short for elliptic filter: {len(window)} samples "
            f"({time_end - time_start:.3f}s), need at least {min_len} samples "
            f"({min_len / fs:.3f}s)."
        )

    filtered = sosfiltfilt(sos, window)

    return {
        "mean": float(np.mean(filtered)),
        "std":  float(np.std(filtered)),
        "peak": float(np.max(np.abs(filtered))),
    }


def elliptical_stats_iterate(
    signal:     np.ndarray,
    time_range: tuple,
    fs:         int = None,
) -> dict:
    """
    Run elliptical_stats() once per standard band (delta, theta, alpha, beta,
    gamma) on one channel's signal for one time window — 5 bands x 3 stats =
    15 datapoints total.

    Args:
        signal:     1D numpy array of EEG samples (µV) for ONE channel, from eeg_filtered_samples.
        time_range: (time_start, time_end) tuple in seconds, relative to the
                    start of this array.
        fs:         Sampling rate (Hz). Defaults to settings.SAMPLE_RATE.

    Returns:
        {
          "delta": {"mean":, "std":, "peak":},
          "theta": {...},
          "alpha": {...},
          "beta":  {...},
          "gamma": {...},
        }
    """
    return {
        band: elliptical_stats(band, signal, time_range, fs)
        for band in BAND_EDGES
    }


def sliding_windows(
    total_duration_s: float,
    window_size_s:    float,
    step_s:           float,
) -> list[tuple]:
    """
    Generate overlapping (or non-overlapping) time windows for a signal of
    known duration. This is the "zoom" control — smaller step_s relative to
    window_size_s gives more overlap (finer time resolution, more windows);
    larger step_s gives less overlap or none (coarser, fewer windows).

    Example: window_size_s=1.0, step_s=0.5 over a 5s signal produces
    windows (0.0,1.0), (0.5,1.5), (1.0,2.0), (1.5,2.5), ... — 50% overlap.

    Args:
        total_duration_s: Total duration of the signal, in seconds.
        window_size_s:    Length of each window, in seconds.
        step_s:           Step between consecutive window starts, in seconds.
                           step_s < window_size_s gives overlap;
                           step_s == window_size_s gives no overlap;
                           step_s > window_size_s skips signal between windows.

    Returns:
        List of (time_start, time_end) tuples, in seconds, covering the
        signal duration. The last window is dropped if it would extend
        past total_duration_s (no zero-padding).

    Raises:
        ValueError: If window_size_s or step_s is not positive.
    """
    if window_size_s <= 0 or step_s <= 0:
        raise ValueError(
            f"window_size_s and step_s must both be positive, "
            f"got window_size_s={window_size_s}, step_s={step_s}."
        )

    windows = []
    current_start = 0.0
    while True:
        current_end = current_start + window_size_s
        if current_end > total_duration_s:
            break
        windows.append((current_start, current_end))
        current_start += step_s

    return windows


def elliptical_stats_sliding(
    freq_band:     str,
    signal:        np.ndarray,
    window_size_s: float = None,
    step_s:        float = None,
    fs:            int   = None,
) -> list[dict]:
    """
    Run elliptical_stats() for one band across every sliding window of a
    full signal. Combines sliding_windows() + elliptical_stats() so the
    caller doesn't have to wire them together manually.

    Args:
        freq_band:     Band name — one of "delta", "theta", "alpha", "beta", "gamma".
        signal:        1D numpy array of EEG samples (uV) for ONE channel.
        window_size_s: Length of each window, in seconds.
                       None (default) = use the full signal as one window.
        step_s:        Step between consecutive windows, in seconds.
                       None (default) = same as window_size_s (no overlap).
        fs:            Sampling rate (Hz). Defaults to settings.SAMPLE_RATE.

    Returns:
        List of dicts, one per window, in chronological order:
          {"time_start": float, "time_end": float,
           "mean": float, "std": float, "peak": float}

    Examples:
        # Specific window size with overlap
        elliptical_stats_sliding("alpha", signal, window_size_s=2.0, step_s=1.0)

        # Full signal as one window (no arguments needed)
        elliptical_stats_sliding("alpha", signal)
    """
    fs = fs or settings.SAMPLE_RATE
    total_duration_s = len(signal) / fs

    # None -> full signal as a single window
    resolved_window = window_size_s if window_size_s is not None else total_duration_s
    # None -> no overlap (step equals window size)
    resolved_step   = step_s        if step_s        is not None else resolved_window

    windows = sliding_windows(total_duration_s, resolved_window, resolved_step)

    results = []
    for time_start, time_end in windows:
        stats = elliptical_stats(freq_band, signal, (time_start, time_end), fs)
        results.append({"time_start": time_start, "time_end": time_end, **stats})

    return results