"""
feature_extraction/ratios.py

Spectral ratios derived from band powers.

Two standard EEG ratios used in cognitive/attention research:

  Theta/Beta Ratio (TBR):
    The most established EEG marker for attention and fatigue.
    Higher TBR is associated with drowsiness, mind-wandering, and reduced
    sustained attention. Lower TBR is associated with focused, alert states.

  Alpha/Beta Ratio (ABR):
    A relaxation-vs-arousal indicator. Higher ABR suggests a more relaxed,
    less alert state; lower ABR suggests active cognitive engagement.

Both ratios are computed per-channel since band powers differ by channel.
"""


def theta_beta_ratio(band_powers: dict) -> float:
    """
    Compute Theta/Beta Ratio (TBR) for one channel.

    Args:
        band_powers: Dict with keys "theta" and "beta" (µV²),
                     from bandpower.all_band_powers().

    Returns:
        TBR as a float. Higher = more drowsy/inattentive,
        lower = more alert/focused.

    Raises:
        ValueError: If beta power is zero (would cause division by zero).
    """
    theta = band_powers["theta"]
    beta  = band_powers["beta"]

    if beta == 0:
        raise ValueError("Beta power is zero — cannot compute Theta/Beta ratio.")

    return theta / beta


def alpha_beta_ratio(band_powers: dict) -> float:
    """
    Compute Alpha/Beta Ratio (ABR) for one channel.

    Args:
        band_powers: Dict with keys "alpha" and "beta" (µV²).

    Returns:
        ABR as a float. Higher = more relaxed, lower = more engaged.

    Raises:
        ValueError: If beta power is zero.
    """
    alpha = band_powers["alpha"]
    beta  = band_powers["beta"]

    if beta == 0:
        raise ValueError("Beta power is zero — cannot compute Alpha/Beta ratio.")

    return alpha / beta


def all_ratios(band_powers: dict) -> dict:
    """
    Compute all spectral ratios for one channel.

    Args:
        band_powers: Dict with keys "delta", "theta", "alpha", "beta", "gamma".

    Returns:
        Dict {"theta_beta_ratio": float, "alpha_beta_ratio": float}
    """
    return {
        "theta_beta_ratio": theta_beta_ratio(band_powers),
        "alpha_beta_ratio": alpha_beta_ratio(band_powers),
    }


def all_ratios_multichannel(band_powers_by_channel: dict) -> dict:
    """
    Compute spectral ratios for all channels.

    Args:
        band_powers_by_channel: Dict {channel_name -> band_powers dict},
                                from bandpower.all_band_powers_multichannel().

    Returns:
        Dict {channel_name -> {"theta_beta_ratio": float, "alpha_beta_ratio": float}}
    """
    return {
        ch: all_ratios(bp)
        for ch, bp in band_powers_by_channel.items()
    }