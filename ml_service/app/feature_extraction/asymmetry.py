"""
feature_extraction/asymmetry.py

Frontal alpha asymmetry (FAA).

Standard formula in affective neuroscience (Davidson's frontal asymmetry index):

    FAA = ln(alpha_power_right) - ln(alpha_power_left)
        = ln(FP2_alpha) - ln(FP1_alpha)

Using log power rather than raw power normalises for the typically
right-skewed distribution of EEG power values and is the convention used
in the published literature on this metric.

Interpretation:
  Positive FAA (right > left in log-alpha)  -> associated with approach
  motivation / positive affect tendency.
  Negative FAA (left > right in log-alpha)  -> associated with withdrawal
  motivation / negative affect tendency.

This is a relative, individual-differences metric — not a clinical diagnostic
measure. It should be interpreted only as one input among several features.

--------------------------------------------------------------------------
ELLIPTIC MIGRATION NOTE:
frontal_alpha_asymmetry_from_bandpowers() now takes elliptical_stats_iterate()
(elliptic_band_stats.py) output (dict {"alpha": {"mean":, "std":, "peak":}, ...})
instead of all_band_powers() output (dict {"alpha": float, ...}).

We use "std" as the stand-in for power, same reasoning as ratios.py: std of
a zero-mean bandpass-filtered oscillation is proportional to RMS amplitude,
the time-domain equivalent of power.

The original FFT/Welch-based version is preserved below as commented-out
code, per project decision to keep FFT as a fallback during the transition.
--------------------------------------------------------------------------
"""

import numpy as np


def frontal_alpha_asymmetry(
    fp1_alpha: float,
    fp2_alpha: float,
) -> float:
    """
    Compute frontal alpha asymmetry from FP1 (left) and FP2 (right) alpha power.

    This function is unchanged by the elliptic migration — it just takes two
    numbers. What changes is what the caller passes in (see
    frontal_alpha_asymmetry_from_bandpowers below).

    Args:
        fp1_alpha: Alpha amplitude proxy at FP1 (left frontal).
        fp2_alpha: Alpha amplitude proxy at FP2 (right frontal).

    Returns:
        FAA index (float). Positive = right > left, negative = left > right.

    Raises:
        ValueError: If either alpha value is zero or negative
                    (log undefined).
    """
    if fp1_alpha <= 0 or fp2_alpha <= 0:
        raise ValueError(
            f"Alpha value must be positive for log transform: "
            f"FP1={fp1_alpha}, FP2={fp2_alpha}"
        )

    return float(np.log(fp2_alpha) - np.log(fp1_alpha))


def frontal_alpha_asymmetry_from_bandpowers(
    band_stats_by_channel: dict,
) -> float:
    """
    Convenience wrapper — extracts FP1/FP2 alpha std and computes FAA.

    Args:
        band_stats_by_channel: Dict {channel_name -> band_stats dict}, from
                                running elliptical_stats_iterate() once
                                per channel. Must contain "fp1" and "fp2" keys,
                                each with an "alpha" sub-dict containing "std".

    Returns:
        FAA index (float).

    Raises:
        KeyError: If fp1 or fp2 channels (or their alpha/std) are missing.
    """
    fp1_alpha = band_stats_by_channel["fp1"]["alpha"]["std"]
    fp2_alpha = band_stats_by_channel["fp2"]["alpha"]["std"]
    return frontal_alpha_asymmetry(fp1_alpha, fp2_alpha)


# ══════════════════════════════════════════════════════════════════════════════
# ORIGINAL FFT/WELCH VERSION — kept as fallback per project decision.
# Operated on all_band_powers() output: dict {"alpha": float, ...} (single
# absolute power value per band, in µV², from Welch PSD integration).
# ══════════════════════════════════════════════════════════════════════════════

# def frontal_alpha_asymmetry(
#     fp1_alpha: float,
#     fp2_alpha: float,
# ) -> float:
#     """
#     Compute frontal alpha asymmetry from FP1 (left) and FP2 (right) alpha power.
#
#     Args:
#         fp1_alpha: Alpha band power (µV²) at FP1 (left frontal).
#         fp2_alpha: Alpha band power (µV²) at FP2 (right frontal).
#
#     Returns:
#         FAA index (float). Positive = right > left, negative = left > right.
#
#     Raises:
#         ValueError: If either alpha power is zero or negative
#                     (log undefined).
#     """
#     if fp1_alpha <= 0 or fp2_alpha <= 0:
#         raise ValueError(
#             f"Alpha power must be positive for log transform: "
#             f"FP1={fp1_alpha}, FP2={fp2_alpha}"
#         )
#
#     return float(np.log(fp2_alpha) - np.log(fp1_alpha))
#
#
# def frontal_alpha_asymmetry_from_bandpowers(
#     band_powers_by_channel: dict,
# ) -> float:
#     """
#     Convenience wrapper — extracts FP1/FP2 alpha power and computes FAA.
#
#     Args:
#         band_powers_by_channel: Dict {channel_name -> band_powers dict},
#                                 from bandpower.all_band_powers_multichannel().
#                                 Must contain "fp1" and "fp2" keys.
#
#     Returns:
#         FAA index (float).
#
#     Raises:
#         KeyError: If fp1 or fp2 channels are missing.
#     """
#     fp1_alpha = band_powers_by_channel["fp1"]["alpha"]
#     fp2_alpha = band_powers_by_channel["fp2"]["alpha"]
#     return frontal_alpha_asymmetry(fp1_alpha, fp2_alpha)
