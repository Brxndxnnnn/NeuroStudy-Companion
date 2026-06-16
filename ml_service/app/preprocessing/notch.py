"""
preprocessing/notch.py

Notch filter to remove electrical mains interference.

Default: 50 Hz (Singapore / EU power grid) + 100 Hz first harmonic.
Change settings.NOTCH_FREQ to 60.0 for US/JP deployments in config.py.

High Q factor (30) keeps the notch narrow to minimise distortion
of genuine EEG content around the mains frequency.
"""

import numpy as np
from scipy.signal import iirnotch, sosfiltfilt, tf2sos
from app.core.config import settings


def design_notch(
    freq: float = None,
    Q:    float = None,
    fs:   int   = None,
) -> np.ndarray:
    """
    Design an IIR notch filter as second-order sections.

    Args:
        freq: Frequency to remove (Hz). Defaults to settings.NOTCH_FREQ.
        Q:    Quality factor. Defaults to settings.NOTCH_Q.
        fs:   Sampling rate (Hz). Defaults to settings.SAMPLE_RATE.

    Returns:
        sos array for use with sosfiltfilt.
    """
    freq = freq or settings.NOTCH_FREQ
    Q    = Q    or settings.NOTCH_Q
    fs   = fs   or settings.SAMPLE_RATE

    if freq >= fs / 2:
        raise ValueError(
            f"Notch frequency {freq} Hz must be below Nyquist ({fs / 2:.1f} Hz)."
        )

    b, a = iirnotch(freq, Q, fs)
    return tf2sos(b, a)


def apply_notch(
    signal:           np.ndarray,
    freq:             float = None,
    Q:                float = None,
    fs:               int   = None,
    remove_harmonic:  bool  = True,
) -> np.ndarray:
    """
    Apply notch filter to remove mains interference from a 1D EEG signal.

    Args:
        signal:          1D numpy array of EEG samples (µV).
        freq:            Mains frequency (Hz).
        Q:               Quality factor.
        fs:              Sampling rate (Hz).
        remove_harmonic: Also notch the 2× harmonic (e.g. 100 Hz for 50 Hz mains).

    Returns:
        Filtered 1D array, same shape as input.
    """
    signal = np.asarray(signal, dtype=np.float64)
    freq   = freq or settings.NOTCH_FREQ
    fs     = fs   or settings.SAMPLE_RATE

    # Primary notch
    sos = design_notch(freq, Q, fs)
    filtered = sosfiltfilt(sos, signal)

    # First harmonic (100 Hz for 50 Hz mains) — only if below Nyquist
    if remove_harmonic and (freq * 2) < (fs / 2):
        sos_h    = design_notch(freq * 2, Q, fs)
        filtered = sosfiltfilt(sos_h, filtered)

    return filtered


def apply_notch_multichannel(signals: dict, **kwargs) -> dict:
    """
    Apply notch filter to all four EEG channels.

    Args:
        signals: Dict {channel_name -> 1D np.ndarray}.
        **kwargs: Forwarded to apply_notch.

    Returns:
        Dict with same keys, each value notch-filtered.
    """
    return {ch: apply_notch(sig, **kwargs) for ch, sig in signals.items()}