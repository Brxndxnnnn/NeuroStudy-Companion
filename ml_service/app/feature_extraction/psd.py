"""
feature_extraction/psd.py

Power Spectral Density estimation using Welch's method.

Welch's method splits the signal into overlapping segments, computes the FFT
of each, and averages the resulting periodograms. This produces a smoother,
less noisy power spectrum than a single FFT — standard practice for EEG.

Input:  1D signal array (µV), already bandpassed + notch filtered.
Output: (frequencies, power_spectral_density) arrays, ready for band power
        integration in bandpower.py.
"""

import numpy as np
from scipy.signal import welch
from app.core.config import settings


def compute_psd(
    signal:    np.ndarray,
    fs:        int   = None,
    nperseg:   int   = None,
    noverlap:  int   = None,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Compute the Power Spectral Density of a 1D EEG signal using Welch's method.

    Args:
        signal:   1D numpy array of EEG samples (µV), already filtered.
        fs:       Sampling rate (Hz). Defaults to settings.SAMPLE_RATE.
        nperseg:  Length of each segment for Welch's method.
                  Defaults to min(256, len(signal)) — standard EEG choice.
        noverlap: Number of overlapping samples between segments.
                  Defaults to nperseg // 2 (50% overlap, the Welch standard).

    Returns:
        (freqs, psd) where:
          freqs: 1D array of frequency bins (Hz)
          psd:   1D array of power spectral density (µV²/Hz) at each frequency

    Raises:
        ValueError: If signal is too short to compute a meaningful PSD.
    """
    signal = np.asarray(signal, dtype=np.float64)
    fs = fs or settings.SAMPLE_RATE

    if len(signal) < 8:
        raise ValueError(
            f"Signal too short for PSD: {len(signal)} samples. Need at least 8."
        )

    # Standard EEG choice: 256-sample segments (~1 second at 250 Hz),
    # but never longer than the signal itself.
    nperseg = nperseg or min(256, len(signal))
    noverlap = noverlap if noverlap is not None else nperseg // 2

    freqs, psd = welch(
        signal,
        fs=fs,
        nperseg=nperseg,
        noverlap=noverlap,
        window="hann",
    )

    return freqs, psd


def compute_psd_multichannel(
    signals: dict,
    **kwargs,
) -> dict:
    """
    Compute PSD for all four EEG channels.

    Args:
        signals: Dict {channel_name -> 1D np.ndarray}, e.g. from pipeline.py windows.
        **kwargs: Forwarded to compute_psd.

    Returns:
        Dict {channel_name -> (freqs, psd)} — one PSD tuple per channel.
    """
    return {ch: compute_psd(sig, **kwargs) for ch, sig in signals.items()}