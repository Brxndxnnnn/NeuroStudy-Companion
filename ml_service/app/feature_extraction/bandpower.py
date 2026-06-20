"""
feature_extraction/bandpower.py

Compute absolute band power (µV²) for each of the five EEG bands:
delta, theta, alpha, beta, gamma.

Band power is the area under the PSD curve within a frequency range,
computed via numerical integration (Simpson's rule) rather than simple
summation, for a more accurate estimate when frequency bins are unevenly
spaced or sparse.
"""

import numpy as np
from scipy.integrate import simpson
from app.core.config import settings


# Band name -> (low_hz, high_hz), pulled from centralised config
BANDS = {
    "delta": settings.BAND_DELTA,
    "theta": settings.BAND_THETA,
    "alpha": settings.BAND_ALPHA,
    "beta":  settings.BAND_BETA,
    "gamma": settings.BAND_GAMMA,
}


def band_power(
    freqs: np.ndarray,
    psd:   np.ndarray,
    band:  tuple,
) -> float:
    """
    Compute absolute power within a frequency band by integrating the PSD.

    Args:
        freqs: 1D array of frequency bins (Hz), from compute_psd().
        psd:   1D array of power spectral density (µV²/Hz), from compute_psd().
        band:  (low_hz, high_hz) tuple defining the band range.

    Returns:
        Absolute power in µV² within the band.

    Raises:
        ValueError: If no frequency bins fall within the requested band.
    """
    low, high = band
    mask = (freqs >= low) & (freqs <= high)

    if not np.any(mask):
        raise ValueError(
            f"No frequency bins found in band {low}-{high} Hz. "
            f"Available range: {freqs.min():.1f}-{freqs.max():.1f} Hz."
        )

    # Simpson's rule integration of PSD over the band — area under the curve
    return float(simpson(psd[mask], freqs[mask]))


def all_band_powers(
    freqs: np.ndarray,
    psd:   np.ndarray,
) -> dict:
    """
    Compute power for all five standard EEG bands.

    Args:
        freqs: 1D array of frequency bins (Hz).
        psd:   1D array of power spectral density (µV²/Hz).

    Returns:
        Dict {"delta": float, "theta": float, "alpha": float,
              "beta": float, "gamma": float} — all in µV².
    """
    return {name: band_power(freqs, psd, rng) for name, rng in BANDS.items()}


def all_band_powers_multichannel(
    psd_results: dict,
) -> dict:
    """
    Compute band powers for all channels.

    Args:
        psd_results: Dict {channel_name -> (freqs, psd)}, from
                     compute_psd_multichannel() in psd.py.

    Returns:
        Dict {channel_name -> {"delta": float, "theta": float, ...}}
    """
    return {
        ch: all_band_powers(freqs, psd)
        for ch, (freqs, psd) in psd_results.items()
    }