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

--------------------------------------------------------------------------
ELLIPTIC MIGRATION NOTE:
This module now takes elliptical_stats_iterate() (elliptic_band_stats.py)
output (dict {"alpha": {"mean":, "std":, "peak":}, ...}) instead of
all_band_powers() output (dict {"alpha": float, ...}).

We use "std" as the stand-in for power: for a zero-mean bandpass-filtered
oscillation, standard deviation is proportional to RMS amplitude, which is
the time-domain equivalent of power. "mean" is near-zero by definition for
an oscillating signal, and "peak" is a single extreme sample — noisier and
less representative than "std".

The original FFT/Welch-based version is preserved below as commented-out
code, per project decision to keep FFT as a fallback during the transition.
--------------------------------------------------------------------------
"""


def theta_beta_ratio(band_stats: dict) -> float:
    """
    Compute Theta/Beta Ratio (TBR) for one channel, using elliptic filter stats.

    Args:
        band_stats: Dict with keys "theta" and "beta", each a stats dict
                    {"mean":, "std":, "peak":}, from
                    elliptical_stats_iterate().

    Returns:
        TBR as a float (theta_std / beta_std). Higher = more drowsy/
        inattentive, lower = more alert/focused.

    Raises:
        ValueError: If beta std is zero (would cause division by zero).
    """
    theta = band_stats["theta"]["std"]
    beta  = band_stats["beta"]["std"]

    if beta == 0:
        raise ValueError("Beta std is zero — cannot compute Theta/Beta ratio.")

    return theta / beta


def alpha_beta_ratio(band_stats: dict) -> float:
    """
    Compute Alpha/Beta Ratio (ABR) for one channel, using elliptic filter stats.

    Args:
        band_stats: Dict with keys "alpha" and "beta", each a stats dict
                    {"mean":, "std":, "peak":}.

    Returns:
        ABR as a float (alpha_std / beta_std). Higher = more relaxed,
        lower = more engaged.

    Raises:
        ValueError: If beta std is zero.
    """
    alpha = band_stats["alpha"]["std"]
    beta  = band_stats["beta"]["std"]

    if beta == 0:
        raise ValueError("Beta std is zero — cannot compute Alpha/Beta ratio.")

    return alpha / beta


def all_ratios(band_stats: dict) -> dict:
    """
    Compute all spectral ratios for one channel, using elliptic filter stats.

    Ratios are computed from "std" only (see migration note above — "mean" is
    near-zero by construction for an oscillating signal and unsuitable for a
    ratio; "peak" is noisier than std as a magnitude estimate). The full
    {mean, std, peak} per band is also included in the output so nothing is
    discarded — callers needing peak-based or mean-based analysis can still
    access it without recomputing the filter.

    Args:
        band_stats: Dict with keys "delta", "theta", "alpha", "beta", "gamma",
                    each a stats dict {"mean":, "std":, "peak":}, from
                    elliptical_stats_iterate().

    Returns:
        Dict {
            "theta_beta_ratio": float,
            "alpha_beta_ratio": float,
            "band_stats": dict   # the original per-band {mean, std, peak}, unchanged
        }
    """
    return {
        "theta_beta_ratio": theta_beta_ratio(band_stats),
        "alpha_beta_ratio": alpha_beta_ratio(band_stats),
        "band_stats": band_stats,
    }


def all_ratios_multichannel(band_stats_by_channel: dict) -> dict:
    """
    Compute spectral ratios for all channels, using elliptic filter stats.

    Args:
        band_stats_by_channel: Dict {channel_name -> band_stats dict},
                                from running elliptical_stats_iterate()
                                once per channel.

    Returns:
        Dict {channel_name -> {"theta_beta_ratio": float, "alpha_beta_ratio": float,
                                "band_stats": dict}}
    """
    return {
        ch: all_ratios(bs)
        for ch, bs in band_stats_by_channel.items()
    }


# ══════════════════════════════════════════════════════════════════════════════
# ORIGINAL FFT/WELCH VERSION — kept as fallback per project decision.
# Operated on all_band_powers() output: dict {"alpha": float, ...} (single
# absolute power value per band, in µV², from Welch PSD integration).
# ══════════════════════════════════════════════════════════════════════════════

# def theta_beta_ratio(band_powers: dict) -> float:
#     """
#     Compute Theta/Beta Ratio (TBR) for one channel.
#
#     Args:
#         band_powers: Dict with keys "theta" and "beta" (µV²),
#                      from bandpower.all_band_powers().
#
#     Returns:
#         TBR as a float. Higher = more drowsy/inattentive,
#         lower = more alert/focused.
#
#     Raises:
#         ValueError: If beta power is zero (would cause division by zero).
#     """
#     theta = band_powers["theta"]
#     beta  = band_powers["beta"]
#
#     if beta == 0:
#         raise ValueError("Beta power is zero — cannot compute Theta/Beta ratio.")
#
#     return theta / beta
#
#
# def alpha_beta_ratio(band_powers: dict) -> float:
#     """
#     Compute Alpha/Beta Ratio (ABR) for one channel.
#
#     Args:
#         band_powers: Dict with keys "alpha" and "beta" (µV²).
#
#     Returns:
#         ABR as a float. Higher = more relaxed, lower = more engaged.
#
#     Raises:
#         ValueError: If beta power is zero.
#     """
#     alpha = band_powers["alpha"]
#     beta  = band_powers["beta"]
#
#     if beta == 0:
#         raise ValueError("Beta power is zero — cannot compute Alpha/Beta ratio.")
#
#     return alpha / beta
#
#
# def all_ratios(band_powers: dict) -> dict:
#     """
#     Compute all spectral ratios for one channel.
#
#     Args:
#         band_powers: Dict with keys "delta", "theta", "alpha", "beta", "gamma".
#
#     Returns:
#         Dict {"theta_beta_ratio": float, "alpha_beta_ratio": float}
#     """
#     return {
#         "theta_beta_ratio": theta_beta_ratio(band_powers),
#         "alpha_beta_ratio": alpha_beta_ratio(band_powers),
#     }
#
#
# def all_ratios_multichannel(band_powers_by_channel: dict) -> dict:
#     """
#     Compute spectral ratios for all channels.
#
#     Args:
#         band_powers_by_channel: Dict {channel_name -> band_powers dict},
#                                 from bandpower.all_band_powers_multichannel().
#
#     Returns:
#         Dict {channel_name -> {"theta_beta_ratio": float, "alpha_beta_ratio": float}}
#     """
#     return {
#         ch: all_ratios(bp)
#         for ch, bp in band_powers_by_channel.items()
#     }