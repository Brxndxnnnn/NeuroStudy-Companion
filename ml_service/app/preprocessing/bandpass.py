"""
preprocessing/bandpass.py

Bandpass filter for EEG signals converted from ADC counts to µV.

Passes only 0.5–45 Hz:
  - Below 0.5 Hz : DC drift, slow electrode movement artefacts
  - Above 45 Hz  : muscle (EMG) noise; safely below Nyquist at 250 Hz

Zero-phase 4th-order Butterworth Filter via sosfiltfilt — no phase distortion,
which is critical for accurate epoch alignment.
"""

import numpy as np
from scipy.signal import butter, sosfiltfilt
from app.core.config import settings


def design_bandpass(
    lowcut:  float = None,
    highcut: float = None,
    fs:      int   = None,
    order:   int   = 4,
):
    """
    Design a Butterworth bandpass filter, returned as second-order sections.

    Args:
        lowcut:  Low cutoff (Hz). Defaults to settings.BANDPASS_LOW.
        highcut: High cutoff (Hz). Defaults to settings.BANDPASS_HIGH.
        fs:      Sampling rate (Hz). Defaults to settings.SAMPLE_RATE.
        order:   Filter order. 4 is standard for EEG.

    Returns:
        sos array for use with sosfiltfilt.
    """
    lowcut  = lowcut  or settings.BANDPASS_LOW
    highcut = highcut or settings.BANDPASS_HIGH
    fs      = fs      or settings.SAMPLE_RATE
    nyq     = fs / 2.0

    low  = lowcut  / nyq
    high = highcut / nyq

    if not (0 < low < high < 1):
        raise ValueError(
            f"Invalid bandpass range: {lowcut}-{highcut} Hz at {fs} Hz. "
            f"Normalised values {low:.3f}-{high:.3f} must be strictly between 0 and 1."
        )

    return butter(order, [low, high], btype="bandpass", output="sos")


def apply_bandpass(
    signal:  np.ndarray,
    lowcut:  float = None,
    highcut: float = None,
    fs:      int   = None,
    order:   int   = 4,
) -> np.ndarray:
    """
    Apply zero-phase bandpass filter to a 1D EEG signal (µV).

    Args:
        signal:  1D numpy array of EEG samples in µV.
        lowcut:  Low cutoff (Hz).
        highcut: High cutoff (Hz).
        fs:      Sampling rate (Hz).
        order:   Filter order.

    Returns:
        Filtered 1D array, same shape as input.

    Raises:
        ValueError: If signal is too short for the chosen filter order.
    """
    signal = np.asarray(signal, dtype=np.float64)

    # sosfiltfilt requires signal length > padlen = 3 * max_filter_order
    min_len = 3 * order * 2
    if len(signal) < min_len:
        raise ValueError(
            f"Signal too short for bandpass: {len(signal)} samples, "
            f"need >= {min_len} for order={order}."
        )

    sos = design_bandpass(lowcut, highcut, fs, order)
    return sosfiltfilt(sos, signal)


def apply_bandpass_multichannel(signals: dict, **kwargs) -> dict:
    """
    Apply bandpass to all four EEG channels.

    Args:
        signals: Dict {channel_name -> 1D np.ndarray} e.g. {"fp1": ..., "fp2": ...}
        **kwargs: Forwarded to apply_bandpass.

    Returns:
        Dict with same keys, each value bandpass-filtered.
    """
    return {ch: apply_bandpass(sig, **kwargs) for ch, sig in signals.items()}