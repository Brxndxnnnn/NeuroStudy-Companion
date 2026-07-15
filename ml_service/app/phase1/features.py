"""
phase1/features.py

Epoch -> feature vector, reusing the existing feature_extraction modules.

Per epoch (4 channels x 2 s):
  - 5 absolute band powers per channel        (Welch PSD, integrated)   20
  - 5 relative band powers per channel        (band / total)            20
  - theta/beta and alpha/beta ratio per ch                               8
  - frontal alpha asymmetry (fp2 vs fp1)                                 1
  - temporal alpha asymmetry (t4 vs t3)                                  1
                                                                        ──
                                                                        50

RELATIVE powers matter as much as absolute ones: absolute EEG amplitude is
dominated by cap fit and skin impedance, which vary per session and have nothing
to do with the stimulus. Relative power is already normalised against that.

FRONTAL ALPHA ASYMMETRY is the standard valence correlate in affective
neuroscience; the ALPHA/BETA RATIO tracks arousal. They are the two features with
a real prior — the rest is there so a model can find what we did not predict.

⚠ Asymmetry is a DIFFERENCE BETWEEN channels, so it is only meaningful when both
channels are alive. With T3/T4 dead, the temporal asymmetry feature is noise, and
if a frontal channel ever dies the frontal one is too. epochs.py drops epochs with
a flat channel, which keeps that from silently reaching the model.
"""

from __future__ import annotations

import numpy as np

from app.core.config import settings
from app.feature_extraction.asymmetry import frontal_alpha_asymmetry
from app.feature_extraction.bandpower import BANDS, all_band_powers_multichannel
from app.feature_extraction.psd import compute_psd_multichannel
from app.phase1.config import DEFAULT, Phase1Config
from app.phase1.epochs import CHANNELS, Epoch
from app.preprocessing.bandpass import apply_bandpass_multichannel
from app.preprocessing.notch import apply_notch_multichannel

BAND_NAMES = list(BANDS.keys())   # delta, theta, alpha, beta, gamma

# Guards a ratio/log against a zero denominator on a near-silent band. Tiny
# relative to real band powers (µV², typically 1e0-1e3), so it cannot shift a
# genuine value — it only stops a division by zero from killing the run.
_EPS = 1e-12


def feature_names() -> list[str]:
    """Feature vector column names, in the exact order build_features emits them."""
    names: list[str] = []
    for ch in CHANNELS:
        names += [f"{ch}_{b}_abs" for b in BAND_NAMES]
    for ch in CHANNELS:
        names += [f"{ch}_{b}_rel" for b in BAND_NAMES]
    for ch in CHANNELS:
        names += [f"{ch}_theta_beta", f"{ch}_alpha_beta"]
    names += ["frontal_alpha_asymmetry", "temporal_alpha_asymmetry"]
    return names


def _preprocess(signals: dict, cfg: Phase1Config) -> dict:
    out = signals
    if cfg.apply_notch:
        out = apply_notch_multichannel(out)
    if cfg.apply_bandpass:
        out = apply_bandpass_multichannel(out)
    return out


def build_features(epoch: Epoch, cfg: Phase1Config = DEFAULT) -> np.ndarray:
    """
    One epoch -> 1D float vector, aligned with feature_names().
    """
    signals = _preprocess(epoch.signals, cfg)

    psds = compute_psd_multichannel(signals, fs=cfg.sample_rate)
    powers = all_band_powers_multichannel(psds)   # {ch: {band: µV²}}

    vec: list[float] = []

    # Absolute band powers.
    for ch in CHANNELS:
        vec += [float(powers[ch][b]) for b in BAND_NAMES]

    # Relative band powers (share of that channel's total power).
    for ch in CHANNELS:
        total = sum(powers[ch][b] for b in BAND_NAMES) + _EPS
        vec += [float(powers[ch][b] / total) for b in BAND_NAMES]

    # Ratios. Computed here rather than via ratios.all_ratios(), which raises on
    # a zero denominator — in a batch of thousands of epochs one silent beta
    # would abort the whole run, so we clamp instead.
    for ch in CHANNELS:
        beta = powers[ch]["beta"] + _EPS
        vec.append(float(powers[ch]["theta"] / beta))
        vec.append(float(powers[ch]["alpha"] / beta))

    # Asymmetries: ln(right alpha) - ln(left alpha).
    vec.append(float(frontal_alpha_asymmetry(
        powers["fp1"]["alpha"] + _EPS,
        powers["fp2"]["alpha"] + _EPS,
    )))
    # Same construction across the temporal pair. NOTE the electrode geometry:
    # T3 is LEFT, T4 is RIGHT — the SDK delivers them in the order T4-then-T3,
    # which the bridge un-swaps on write, so these column names are correct and
    # must not be "fixed" to match frame order.
    vec.append(float(
        np.log(powers["t4"]["alpha"] + _EPS) - np.log(powers["t3"]["alpha"] + _EPS)
    ))

    return np.asarray(vec, dtype=np.float64)


def build_matrix(
    epochs: list[Epoch],
    cfg: Phase1Config = DEFAULT,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Epochs -> (X, y, groups, sessions) ready for evaluate.py.

      X        [n_epochs, n_features]
      y        [n_epochs, 2]   columns are (valence, arousal)
      groups   [n_epochs]      image_id — the CV grouping key, see evaluate.py
      sessions [n_epochs]      session_id — for per-session normalisation
    """
    if not epochs:
        n = len(feature_names())
        return (np.empty((0, n)), np.empty((0, 2)),
                np.empty(0, dtype=object), np.empty(0, dtype=object))

    X = np.vstack([build_features(e, cfg) for e in epochs])
    y = np.array([[e.valence, e.arousal] for e in epochs], dtype=np.float64)
    groups = np.array([e.image_id for e in epochs], dtype=object)
    sessions = np.array([e.session_id for e in epochs], dtype=object)
    return X, y, groups, sessions
