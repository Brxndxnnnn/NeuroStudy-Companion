"""
tests/test_features.py

Tests for feature extraction — covers:
  - psd.py                 : Welch PSD estimation
  - bandpower.py           : band power integration for all 5 bands
  - ratios.py              : theta/beta and alpha/beta ratios
  - asymmetry.py           : frontal alpha asymmetry
  - elliptic_band_stats.py : elliptic bandpass filter mean/std/peak per band
  - pipeline.py            : elliptic sliding-window orchestration

Each test class validates against a SYNTHETIC signal with known ground truth
first, then immediately runs the same computation on REAL session data.

Run:
    pytest app/tests/test_features.py -v -s
"""

import numpy as np
import pytest

from app.core.config import settings
from app.feature_extraction.psd import compute_psd, compute_psd_multichannel
from app.feature_extraction.bandpower import band_power, all_band_powers, all_band_powers_multichannel
from app.feature_extraction.elliptic_band_stats import (
    elliptical_stats,
    elliptical_stats_iterate,
    elliptical_stats_sliding,
    design_elliptic_bandpass,
    sliding_windows,
)
from app.feature_extraction.pipeline import elliptic_sliding_multichannel
from app.feature_extraction.ratios import theta_beta_ratio, alpha_beta_ratio, all_ratios, all_ratios_multichannel
from app.feature_extraction.asymmetry import frontal_alpha_asymmetry, frontal_alpha_asymmetry_from_bandpowers
from app.preprocessing.pipeline import run_pipeline
from app.data_access.queries import fetch_filtered_samples


def _make_band_signal(freq_hz: float, amplitude: float, duration_s: float = 4.0, noise_std: float = 0.5):
    """Helper: build a sine wave at a given frequency with light noise — known ground truth."""
    fs = settings.SAMPLE_RATE
    t  = np.arange(int(duration_s * fs)) / fs
    return amplitude * np.sin(2 * np.pi * freq_hz * t) + np.random.randn(len(t)) * noise_std


def _first_real_window(db_conn, session_id):
    """Helper: run pipeline.py and return the first clean window's signals.
    Source: eeg_raw_samples -> ADC conversion -> Butterworth bandpass + notch.
    Used by the FFT/Welch path (TestPSD, TestBandPower) and the legacy
    commented-out FFT variants of TestRatios/TestAsymmetry below."""
    result = run_pipeline(db_conn, session_id)
    return result["windows"][0]["signals"]


def _first_filtered_window(db_conn, session_id, fetch_duration_s: float = None):
    """
    Helper: fetch SDK-filtered samples directly from eeg_filtered_samples.

    Args:
        db_conn:          Open SQLAlchemy connection.
        session_id:       UUID string.
        fetch_duration_s: How many seconds of signal to fetch from the DB,
                          starting from the first sample of the session.
                          None (default) = fetch the ENTIRE session signal.

    Returns:
        Dict {"fp1": np.ndarray, "fp2": ..., "t3": ..., "t4": ...} in µV.

    Raises:
        ValueError: If eeg_filtered_samples has no rows for this session.
    """
    samples = fetch_filtered_samples(db_conn, session_id)
    if not samples:
        raise ValueError(
            f"No eeg_filtered_samples found for session {session_id}. "
            f"Elliptic path requires SDK-filtered data — check the bridge "
            f"is writing to eeg_filtered_samples for this session."
        )

    fs = settings.SAMPLE_RATE
    if fetch_duration_s is not None:
        n_needed = int(fetch_duration_s * fs)
        samples  = samples[:n_needed]

    return {
        ch: np.array([row[ch] for row in samples], dtype=np.float64)
        for ch in settings.CHANNELS
    }


# ══════════════════════════════════════════════════════════════════════════════
# 1. PSD — psd.py
# ══════════════════════════════════════════════════════════════════════════════

class TestPSD:
    def test_returns_freqs_and_psd(self):
        signal = _make_band_signal(freq_hz=10.0, amplitude=15.0)
        freqs, psd = compute_psd(signal)
        assert len(freqs) == len(psd)
        assert freqs[0] >= 0

    def test_peak_at_injected_frequency_synthetic(self):
        """Synthetic ground truth: 10 Hz sine wave should peak near 10 Hz."""
        signal = _make_band_signal(freq_hz=10.0, amplitude=20.0)
        freqs, psd = compute_psd(signal)
        peak_freq = freqs[np.argmax(psd)]
        print(f"\n  [SYNTHETIC] Injected 10 Hz -> detected peak at {peak_freq:.2f} Hz")
        assert abs(peak_freq - 10.0) < 1.5

    def test_peak_at_beta_frequency_synthetic(self):
        """Synthetic ground truth: 20 Hz sine wave should peak near 20 Hz."""
        signal = _make_band_signal(freq_hz=20.0, amplitude=20.0)
        freqs, psd = compute_psd(signal)
        peak_freq = freqs[np.argmax(psd)]
        print(f"\n  [SYNTHETIC] Injected 20 Hz -> detected peak at {peak_freq:.2f} Hz")
        assert abs(peak_freq - 20.0) < 1.5

    def test_peak_on_real_session(self, db_conn, session_id):
        """Real data: show the PSD peak for each channel on the first clean window."""
        signals = _first_real_window(db_conn, session_id)
        psd_results = compute_psd_multichannel(signals)
        print(f"\n  [REAL] PSD peak per channel:")
        for ch, (freqs, psd) in psd_results.items():
            peak_freq = freqs[np.argmax(psd)]
            print(f"    {ch}: peak at {peak_freq:.2f} Hz")
        assert len(psd_results) == 4

    def test_too_short_raises(self):
        with pytest.raises(ValueError, match="too short"):
            compute_psd(np.ones(3))

    def test_multichannel_synthetic(self):
        signals = {ch: _make_band_signal(10.0, 15.0) for ch in settings.CHANNELS}
        result  = compute_psd_multichannel(signals)
        assert set(result.keys()) == set(settings.CHANNELS)


# ══════════════════════════════════════════════════════════════════════════════
# 2. Band power — bandpower.py
# ══════════════════════════════════════════════════════════════════════════════

class TestBandPower:
    def test_alpha_dominant_synthetic(self):
        """Synthetic ground truth: pure 10 Hz signal -> alpha power should dominate."""
        signal = _make_band_signal(freq_hz=10.0, amplitude=20.0)
        freqs, psd = compute_psd(signal)
        powers = all_band_powers(freqs, psd)
        print(f"\n  [SYNTHETIC] Band powers (10 Hz signal): {powers}")
        assert powers["alpha"] > powers["delta"]
        assert powers["alpha"] > powers["beta"]

    def test_beta_dominant_synthetic(self):
        """Synthetic ground truth: pure 20 Hz signal -> beta power should dominate."""
        signal = _make_band_signal(freq_hz=20.0, amplitude=20.0)
        freqs, psd = compute_psd(signal)
        powers = all_band_powers(freqs, psd)
        print(f"\n  [SYNTHETIC] Band powers (20 Hz signal): {powers}")
        assert powers["beta"] > powers["theta"]

    def test_band_powers_on_real_session(self, db_conn, session_id):
        """Real data: show band powers for every channel on the first clean window."""
        signals = _first_real_window(db_conn, session_id)
        psd_results = compute_psd_multichannel(signals)
        powers = all_band_powers_multichannel(psd_results)
        print(f"\n  [REAL] Band powers per channel:")
        for ch, bp in powers.items():
            print(f"    {ch}: " + ", ".join(f"{band}={val:.2f}" for band, val in bp.items()))
        assert set(powers.keys()) == {"fp1", "fp2", "t3", "t4"}
        for ch, bp in powers.items():
            for band, val in bp.items():
                assert val >= 0, f"{ch} {band} power is negative: {val}"

    def test_all_five_bands_present(self):
        signal = _make_band_signal(freq_hz=10.0, amplitude=15.0)
        freqs, psd = compute_psd(signal)
        powers = all_band_powers(freqs, psd)
        assert set(powers.keys()) == {"delta", "theta", "alpha", "beta", "gamma"}

    def test_band_power_is_positive(self):
        signal = _make_band_signal(freq_hz=10.0, amplitude=15.0)
        freqs, psd = compute_psd(signal)
        powers = all_band_powers(freqs, psd)
        for band, power in powers.items():
            assert power >= 0, f"{band} power is negative: {power}"

    def test_invalid_band_raises(self):
        signal = _make_band_signal(freq_hz=10.0, amplitude=15.0)
        freqs, psd = compute_psd(signal)
        with pytest.raises(ValueError, match="No frequency bins"):
            band_power(freqs, psd, (1000.0, 2000.0))

    def test_multichannel(self):
        signals = {ch: _make_band_signal(10.0, 15.0) for ch in settings.CHANNELS}
        psd_results = compute_psd_multichannel(signals)
        powers = all_band_powers_multichannel(psd_results)
        assert set(powers.keys()) == set(settings.CHANNELS)
        for ch, bp in powers.items():
            assert set(bp.keys()) == {"delta", "theta", "alpha", "beta", "gamma"}


# ══════════════════════════════════════════════════════════════════════════════
# 3. Spectral ratios — ratios.py (now elliptic-based)
# ══════════════════════════════════════════════════════════════════════════════

class TestRatios:
    def test_theta_dominant_gives_high_tbr_synthetic(self):
        """Synthetic ground truth: theta-dominant signal -> TBR > 1 (elliptic std-based)."""
        signal = _make_band_signal(freq_hz=6.0, amplitude=20.0)
        stats = elliptical_stats_iterate(signal, (0.0, 4.0), settings.SAMPLE_RATE)
        tbr = theta_beta_ratio(stats)
        print(f"\n  [SYNTHETIC] Theta-dominant signal TBR: {tbr:.2f}")
        assert tbr > 1.0

    def test_beta_dominant_gives_low_tbr_synthetic(self):
        """Synthetic ground truth: beta-dominant signal -> TBR < 1 (elliptic std-based)."""
        signal = _make_band_signal(freq_hz=20.0, amplitude=20.0)
        stats = elliptical_stats_iterate(signal, (0.0, 4.0), settings.SAMPLE_RATE)
        tbr = theta_beta_ratio(stats)
        print(f"\n  [SYNTHETIC] Beta-dominant signal TBR: {tbr:.2f}")
        assert tbr < 1.0

    def test_ratios_on_real_session(self, db_conn, session_id):
        """Real data: compute TBR and ABR across sliding windows using SDK-filtered
        samples from eeg_filtered_samples. Shows ratios per window per channel."""
        signals = _first_filtered_window(db_conn, session_id)
        window_size_s = 1.0   # configurable
        step_s        = 0.5   # configurable
        windows = elliptic_sliding_multichannel(signals, window_size_s, step_s)
        print(f"\n  [REAL] Ratios across {len(windows)} sliding windows "
              f"(window={window_size_s}s, step={step_s}s):")
        for i, w in enumerate(windows[:3]):   # show first 3 windows
            ratios = all_ratios_multichannel(w["features"])
            print(f"    window {i} [{w['time_start']:.1f}-{w['time_end']:.1f}s]:")
            for ch, r in ratios.items():
                print(f"      {ch}: TBR={r['theta_beta_ratio']:.2f}, "
                      f"ABR={r['alpha_beta_ratio']:.2f}")
        assert len(windows) > 0
        assert set(windows[0]["features"].keys()) == {"fp1", "fp2", "t3", "t4"}

    def test_zero_beta_raises(self):
        stats = {
            "theta": {"mean": 0.0, "std": 5.0, "peak": 5.0},
            "beta":  {"mean": 0.0, "std": 0.0, "peak": 0.0},
            "alpha": {"mean": 0.0, "std": 3.0, "peak": 3.0},
        }
        with pytest.raises(ValueError, match="zero"):
            theta_beta_ratio(stats)

    def test_alpha_beta_ratio_computes(self):
        stats = {
            "alpha": {"mean": 0.0, "std": 10.0, "peak": 10.0},
            "beta":  {"mean": 0.0, "std": 5.0,  "peak": 5.0},
            "theta": {"mean": 0.0, "std": 2.0,  "peak": 2.0},
        }
        abr = alpha_beta_ratio(stats)
        assert abr == 2.0

    def test_all_ratios_returns_both_plus_band_stats(self):
        stats = {
            "delta": {"mean": 0.0, "std": 1.0,  "peak": 1.0},
            "theta": {"mean": 0.0, "std": 5.0,  "peak": 5.0},
            "alpha": {"mean": 0.0, "std": 10.0, "peak": 10.0},
            "beta":  {"mean": 0.0, "std": 5.0,  "peak": 5.0},
            "gamma": {"mean": 0.0, "std": 1.0,  "peak": 1.0},
        }
        ratios = all_ratios(stats)
        assert "theta_beta_ratio" in ratios
        assert "alpha_beta_ratio" in ratios
        assert "band_stats" in ratios
        assert ratios["band_stats"] == stats


# ── ORIGINAL FFT/WELCH VERSION — kept as fallback per project decision ────────
# Operated on all_band_powers() output: dict {"alpha": float, ...}.
#
# class TestRatios:
#     def test_theta_dominant_gives_high_tbr_synthetic(self):
#         """Synthetic ground truth: theta-dominant signal -> TBR > 1."""
#         signal = _make_band_signal(freq_hz=6.0, amplitude=20.0)
#         freqs, psd = compute_psd(signal)
#         powers = all_band_powers(freqs, psd)
#         tbr = theta_beta_ratio(powers)
#         print(f"\n  [SYNTHETIC] Theta-dominant signal TBR: {tbr:.2f}")
#         assert tbr > 1.0
#
#     def test_beta_dominant_gives_low_tbr_synthetic(self):
#         """Synthetic ground truth: beta-dominant signal -> TBR < 1."""
#         signal = _make_band_signal(freq_hz=20.0, amplitude=20.0)
#         freqs, psd = compute_psd(signal)
#         powers = all_band_powers(freqs, psd)
#         tbr = theta_beta_ratio(powers)
#         print(f"\n  [SYNTHETIC] Beta-dominant signal TBR: {tbr:.2f}")
#         assert tbr < 1.0
#
#     def test_ratios_on_real_session(self, db_conn, session_id):
#         """Real data: show TBR and ABR for every channel on the first clean window."""
#         signals = _first_real_window(db_conn, session_id)
#         psd_results = compute_psd_multichannel(signals)
#         powers = all_band_powers_multichannel(psd_results)
#         ratios = all_ratios_multichannel(powers)
#         print(f"\n  [REAL] Spectral ratios per channel:")
#         for ch, r in ratios.items():
#             print(f"    {ch}: TBR={r['theta_beta_ratio']:.2f}, ABR={r['alpha_beta_ratio']:.2f}")
#         assert set(ratios.keys()) == {"fp1", "fp2", "t3", "t4"}
#
#     def test_zero_beta_raises(self):
#         powers = {"theta": 5.0, "beta": 0.0, "alpha": 3.0}
#         with pytest.raises(ValueError, match="zero"):
#             theta_beta_ratio(powers)
#
#     def test_alpha_beta_ratio_computes(self):
#         powers = {"alpha": 10.0, "beta": 5.0, "theta": 2.0}
#         abr = alpha_beta_ratio(powers)
#         assert abr == 2.0
#
#     def test_all_ratios_returns_both(self):
#         powers = {"delta": 1.0, "theta": 5.0, "alpha": 10.0, "beta": 5.0, "gamma": 1.0}
#         ratios = all_ratios(powers)
#         assert "theta_beta_ratio" in ratios
#         assert "alpha_beta_ratio" in ratios


# ══════════════════════════════════════════════════════════════════════════════
# 4. Frontal alpha asymmetry — asymmetry.py (now elliptic-based)
# ══════════════════════════════════════════════════════════════════════════════

class TestAsymmetry:
    def test_right_greater_gives_positive_faa_synthetic(self):
        """Synthetic ground truth: FP2 (right) alpha > FP1 (left) alpha -> positive FAA.
        (frontal_alpha_asymmetry itself is unchanged by the elliptic migration —
        it just takes two numbers; only the wrapper's input shape changed.)"""
        faa = frontal_alpha_asymmetry(fp1_alpha=5.0, fp2_alpha=15.0)
        print(f"\n  [SYNTHETIC] FP1=5.0 FP2=15.0 -> FAA={faa:.3f}")
        assert faa > 0

    def test_left_greater_gives_negative_faa_synthetic(self):
        """Synthetic ground truth: FP1 (left) alpha > FP2 (right) alpha -> negative FAA."""
        faa = frontal_alpha_asymmetry(fp1_alpha=15.0, fp2_alpha=5.0)
        print(f"\n  [SYNTHETIC] FP1=15.0 FP2=5.0 -> FAA={faa:.3f}")
        assert faa < 0

    def test_faa_on_real_session(self, db_conn, session_id):
        """Real data: compute frontal alpha asymmetry across sliding windows
        using SDK-filtered samples from eeg_filtered_samples."""
        signals = _first_filtered_window(db_conn, session_id)
        window_size_s = 1.0   # configurable
        step_s        = 0.5   # configurable
        windows = elliptic_sliding_multichannel(signals, window_size_s, step_s)
        print(f"\n  [REAL] FAA across {len(windows)} sliding windows "
              f"(window={window_size_s}s, step={step_s}s):")
        for i, w in enumerate(windows[:3]):
            faa = frontal_alpha_asymmetry_from_bandpowers(w["features"])
            fp1_std = w["features"]["fp1"]["alpha"]["std"]
            fp2_std = w["features"]["fp2"]["alpha"]["std"]
            print(f"    window {i} [{w['time_start']:.1f}-{w['time_end']:.1f}s]: "
                  f"FP1_alpha_std={fp1_std:.2f}, FP2_alpha_std={fp2_std:.2f}, "
                  f"FAA={faa:.4f}")
        assert len(windows) > 0

    def test_zero_alpha_raises(self):
        with pytest.raises(ValueError, match="positive"):
            frontal_alpha_asymmetry(fp1_alpha=0.0, fp2_alpha=10.0)

    def test_equal_alpha_gives_zero_faa(self):
        faa = frontal_alpha_asymmetry(fp1_alpha=10.0, fp2_alpha=10.0)
        assert abs(faa) < 1e-9

    def test_negative_alpha_raises(self):
        with pytest.raises(ValueError, match="positive"):
            frontal_alpha_asymmetry(fp1_alpha=-5.0, fp2_alpha=10.0)

    def test_from_bandpowers_wrapper(self):
        """Wrapper now expects elliptic-shaped stats: {"alpha": {"std": ...}}."""
        band_stats_by_channel = {
            "fp1": {"alpha": {"mean": 0.0, "std": 5.0,  "peak": 5.0}},
            "fp2": {"alpha": {"mean": 0.0, "std": 15.0, "peak": 15.0}},
        }
        faa = frontal_alpha_asymmetry_from_bandpowers(band_stats_by_channel)
        assert faa > 0


# ── ORIGINAL FFT/WELCH VERSION — kept as fallback per project decision ────────
# Operated on all_band_powers() output: dict {"alpha": float, ...}.
#
# class TestAsymmetry:
#     def test_right_greater_gives_positive_faa_synthetic(self):
#         """Synthetic ground truth: FP2 (right) alpha > FP1 (left) alpha -> positive FAA."""
#         faa = frontal_alpha_asymmetry(fp1_alpha=5.0, fp2_alpha=15.0)
#         print(f"\n  [SYNTHETIC] FP1=5.0 FP2=15.0 -> FAA={faa:.3f}")
#         assert faa > 0
#
#     def test_left_greater_gives_negative_faa_synthetic(self):
#         """Synthetic ground truth: FP1 (left) alpha > FP2 (right) alpha -> negative FAA."""
#         faa = frontal_alpha_asymmetry(fp1_alpha=15.0, fp2_alpha=5.0)
#         print(f"\n  [SYNTHETIC] FP1=15.0 FP2=5.0 -> FAA={faa:.3f}")
#         assert faa < 0
#
#     def test_faa_on_real_session(self, db_conn, session_id):
#         """Real data: show frontal alpha asymmetry on the first clean window."""
#         signals = _first_real_window(db_conn, session_id)
#         psd_results = compute_psd_multichannel(signals)
#         powers = all_band_powers_multichannel(psd_results)
#         faa = frontal_alpha_asymmetry_from_bandpowers(powers)
#         print(f"\n  [REAL] FP1 alpha={powers['fp1']['alpha']:.2f}, "
#               f"FP2 alpha={powers['fp2']['alpha']:.2f} -> FAA={faa:.4f}")
#         assert isinstance(faa, float)
#
#     def test_zero_alpha_raises(self):
#         with pytest.raises(ValueError, match="positive"):
#             frontal_alpha_asymmetry(fp1_alpha=0.0, fp2_alpha=10.0)
#
#     def test_equal_alpha_gives_zero_faa(self):
#         faa = frontal_alpha_asymmetry(fp1_alpha=10.0, fp2_alpha=10.0)
#         assert abs(faa) < 1e-9
#
#     def test_negative_alpha_raises(self):
#         with pytest.raises(ValueError, match="positive"):
#             frontal_alpha_asymmetry(fp1_alpha=-5.0, fp2_alpha=10.0)
#
#     def test_from_bandpowers_wrapper(self):
#         band_powers_by_channel = {
#             "fp1": {"alpha": 5.0},
#             "fp2": {"alpha": 15.0},
#         }
#         faa = frontal_alpha_asymmetry_from_bandpowers(band_powers_by_channel)
#         assert faa > 0


# ══════════════════════════════════════════════════════════════════════════════
# 5. Elliptic band stats — elliptic_band_stats.py
# ══════════════════════════════════════════════════════════════════════════════

class TestEllipticBandStats:
    def test_theta_band_isolates_theta_synthetic(self):
        """Synthetic ground truth: theta-frequency signal -> theta-band filtered
        std should dominate the beta-band filtered std."""
        signal = _make_band_signal(freq_hz=6.0, amplitude=20.0)
        theta_stats = elliptical_stats("theta", signal, (0.0, 4.0), settings.SAMPLE_RATE)
        beta_stats  = elliptical_stats("beta",  signal, (0.0, 4.0), settings.SAMPLE_RATE)
        print(f"\n  [SYNTHETIC] 6 Hz signal -> theta std={theta_stats['std']:.2f}, "
              f"beta std={beta_stats['std']:.2f}")
        assert theta_stats["std"] > beta_stats["std"]

    def test_beta_band_isolates_beta_synthetic(self):
        """Synthetic ground truth: beta-frequency signal -> beta-band filtered
        std should dominate the theta-band filtered std."""
        signal = _make_band_signal(freq_hz=20.0, amplitude=20.0)
        theta_stats = elliptical_stats("theta", signal, (0.0, 4.0), settings.SAMPLE_RATE)
        beta_stats  = elliptical_stats("beta",  signal, (0.0, 4.0), settings.SAMPLE_RATE)
        print(f"\n  [SYNTHETIC] 20 Hz signal -> theta std={theta_stats['std']:.2f}, "
              f"beta std={beta_stats['std']:.2f}")
        assert beta_stats["std"] > theta_stats["std"]

    def test_unknown_band_raises_keyerror(self):
        with pytest.raises(KeyError, match="Unknown freq_band"):
            design_elliptic_bandpass("not_a_band", settings.SAMPLE_RATE)

    def test_band_edges_above_nyquist_raises(self):
        """Gamma band (30-45 Hz) is invalid at a sample rate whose Nyquist is below it."""
        with pytest.raises(ValueError, match="Invalid band range"):
            design_elliptic_bandpass("gamma", fs=60)

    def test_window_too_short_raises(self):
        signal = _make_band_signal(freq_hz=10.0, amplitude=15.0, duration_s=4.0)
        with pytest.raises(ValueError, match="too short"):
            elliptical_stats("alpha", signal, (0.0, 0.05), settings.SAMPLE_RATE)

    def test_time_window_out_of_range_raises(self):
        signal = _make_band_signal(freq_hz=10.0, amplitude=15.0, duration_s=4.0)
        with pytest.raises(ValueError, match="Invalid time window"):
            elliptical_stats("alpha", signal, (0.0, 10.0), settings.SAMPLE_RATE)

    def test_iterate_returns_all_five_bands_synthetic(self):
        signal = _make_band_signal(freq_hz=10.0, amplitude=15.0)
        stats = elliptical_stats_iterate(signal, (0.0, 4.0), settings.SAMPLE_RATE)
        assert set(stats.keys()) == {"delta", "theta", "alpha", "beta", "gamma"}
        for band_stats in stats.values():
            assert set(band_stats.keys()) == {"mean", "std", "peak"}

    def test_iterate_on_real_session(self, db_conn, session_id):
        """Real data (read-only): run elliptical_stats_iterate on one channel's
        SDK-filtered signal for the first second of the session."""
        signals = _first_filtered_window(db_conn, session_id, fetch_duration_s=2.0)
        fp1 = signals["fp1"]
        stats = elliptical_stats_iterate(fp1, (0.0, 1.0), settings.SAMPLE_RATE)
        print(f"\n  [REAL] fp1 band stats (0-1s): " +
              ", ".join(f"{band}.std={s['std']:.2f}" for band, s in stats.items()))
        assert set(stats.keys()) == {"delta", "theta", "alpha", "beta", "gamma"}

    def test_sliding_windows_no_overlap(self):
        windows = sliding_windows(total_duration_s=5.0, window_size_s=1.0, step_s=1.0)
        assert windows == [(0.0, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 4.0), (4.0, 5.0)]

    def test_sliding_windows_with_overlap(self):
        windows = sliding_windows(total_duration_s=2.0, window_size_s=1.0, step_s=0.5)
        expected = [(0.0, 1.0), (0.5, 1.5), (1.0, 2.0)]
        assert len(windows) == len(expected)
        for (actual_start, actual_end), (exp_start, exp_end) in zip(windows, expected):
            assert actual_start == pytest.approx(exp_start)
            assert actual_end == pytest.approx(exp_end)

    def test_sliding_windows_drops_trailing_partial_window(self):
        """2.5s of signal with 1.0s windows -> only 2 full windows fit (0-1, 1-2);
        the partial 2.0-3.0 window is dropped rather than zero-padded."""
        windows = sliding_windows(total_duration_s=2.5, window_size_s=1.0, step_s=1.0)
        assert windows == [(0.0, 1.0), (1.0, 2.0)]

    def test_sliding_windows_invalid_size_raises(self):
        with pytest.raises(ValueError, match="must both be positive"):
            sliding_windows(total_duration_s=5.0, window_size_s=0, step_s=1.0)

    def test_sliding_windows_invalid_step_raises(self):
        with pytest.raises(ValueError, match="must both be positive"):
            sliding_windows(total_duration_s=5.0, window_size_s=1.0, step_s=-1.0)

    def test_elliptical_stats_sliding_synthetic(self):
        signal = _make_band_signal(freq_hz=10.0, amplitude=15.0, duration_s=5.0)
        results = elliptical_stats_sliding("alpha", signal, window_size_s=1.0, step_s=1.0,
                                            fs=settings.SAMPLE_RATE)
        assert len(results) == 5
        for r in results:
            assert set(r.keys()) == {"time_start", "time_end", "mean", "std", "peak"}


# ══════════════════════════════════════════════════════════════════════════════
# 6. Elliptic pipeline orchestration — pipeline.py
# ══════════════════════════════════════════════════════════════════════════════

class TestPipeline:
    def test_explicit_window_and_step_used_synthetic(self):
        """window_size_s/step_s passed explicitly should override any config default."""
        signals = {ch: _make_band_signal(10.0, 15.0, duration_s=4.0) for ch in settings.CHANNELS}
        windows = elliptic_sliding_multichannel(signals, window_size_s=1.0, step_s=1.0)
        assert len(windows) == 4
        assert windows[0]["time_start"] == pytest.approx(0.0)
        assert windows[0]["time_end"] == pytest.approx(1.0)
        assert set(windows[0]["features"].keys()) == set(settings.CHANNELS)
        for band_stats in windows[0]["features"]["fp1"].values():
            assert set(band_stats.keys()) == {"mean", "std", "peak"}

    def test_none_params_falls_back_to_full_signal_synthetic(self, monkeypatch):
        """With no explicit window/step and no config default (settings.ELLIPTIC_*
        = None), the full signal should be treated as a single window."""
        monkeypatch.setattr(settings, "ELLIPTIC_WINDOW_SIZE_S", None)
        monkeypatch.setattr(settings, "ELLIPTIC_STEP_S", None)
        signals = {ch: _make_band_signal(10.0, 15.0, duration_s=4.0) for ch in settings.CHANNELS}
        windows = elliptic_sliding_multichannel(signals)
        assert len(windows) == 1
        assert windows[0]["time_start"] == pytest.approx(0.0)
        assert windows[0]["time_end"] == pytest.approx(4.0)

    def test_none_params_uses_config_default_synthetic(self, monkeypatch):
        """With no explicit window/step, settings.ELLIPTIC_WINDOW_SIZE_S/STEP_S
        (config.py) should be used as the default."""
        monkeypatch.setattr(settings, "ELLIPTIC_WINDOW_SIZE_S", 1.0)
        monkeypatch.setattr(settings, "ELLIPTIC_STEP_S", 0.5)
        signals = {ch: _make_band_signal(10.0, 15.0, duration_s=2.0) for ch in settings.CHANNELS}
        windows = elliptic_sliding_multichannel(signals)
        assert len(windows) == 3   # (0,1), (0.5,1.5), (1,2)

    def test_on_real_session(self, db_conn, session_id):
        """Real data (read-only): run the elliptic sliding pipeline on a short
        slice of SDK-filtered samples and check the shape of the output."""
        signals = _first_filtered_window(db_conn, session_id, fetch_duration_s=3.0)
        windows = elliptic_sliding_multichannel(signals, window_size_s=1.0, step_s=1.0)
        print(f"\n  [REAL] {len(windows)} windows from a 3s slice (1.0s windows, no overlap)")
        assert len(windows) == 3
        for w in windows:
            assert set(w["features"].keys()) == {"fp1", "fp2", "t3", "t4"}
            for band_stats in w["features"]["fp1"].values():
                assert set(band_stats.keys()) == {"mean", "std", "peak"}


# ══════════════════════════════════════════════════════════════════════════════
# 7. End-to-end summary on real session — full chain in one place (elliptic)
# ══════════════════════════════════════════════════════════════════════════════

class TestFeaturesOnRealSession:
    def test_full_feature_extraction_on_real_window(self, db_conn, session_id):
        """
        Full elliptic pipeline on SDK-filtered samples from eeg_filtered_samples.

        Pipeline per window:
          eeg_filtered_samples (SDK-filtered, already µV)
              -> 5 elliptic bandpass filters (delta/theta/alpha/beta/gamma)
              -> mean, std, peak per band per channel
              -> 5 bands x 3 features x 4 channels = 60 features per window

        Three configurable parameters control the analysis:
          fetch_duration_s — how many seconds to pull from the DB
                             (in _first_filtered_window below; None = full session)
          window_size_s    — size of each analysis window in seconds
                             (None = full fetched signal as one window)
          step_s           — step between windows in seconds
                             (smaller = more overlap (zoom in),
                             larger = less overlap (zoom out), None = no overlap)
        """
        # ── HOW MUCH SIGNAL TO FETCH FROM DB ──────────────────────────────────
        # Change fetch_duration_s to test on a shorter slice, e.g. 10.0 for 10s.
        # Set to None to use the entire session.
        fetch_duration_s = None   # None = full session

        signals = _first_filtered_window(db_conn, session_id, fetch_duration_s)

        # ── HOW TO SLICE THE FETCHED SIGNAL INTO WINDOWS ───────────────────────
        # Option A: sliding windows of a specific size
        window_size_s = 1.0    # size of each analysis window in seconds
        step_s        = 0.5    # step between windows (0.5s step = 50% overlap at 1.0s window)

        # Option B: full fetched signal as one window (uncomment to use)
        # window_size_s = None
        # step_s        = None

        # ── HOW MANY WINDOWS TO PRINT IN OUTPUT ───────────────────────────────
        MAX_PRINT = 5   # change to see more/fewer windows printed

        windows = elliptic_sliding_multichannel(signals, window_size_s, step_s)

        # Feature count from first window — same structure across all windows
        n_bands    = len(windows[0]["features"][settings.CHANNELS[0]])
        n_stats    = len(list(windows[0]["features"][settings.CHANNELS[0]].values())[0])
        n_channels = len(settings.CHANNELS)
        feature_count = n_bands * n_stats * n_channels

        any_sig = next(iter(signals.values()))
        total_s = len(any_sig) / settings.SAMPLE_RATE
        mode    = "FULL SIGNAL" if window_size_s is None else f"{window_size_s}s windows"

        print(f"\n  [SUMMARY] SDK-filtered samples -> elliptic ({mode})")
        print(f"  [SUMMARY] fetched={total_s:.1f}s, "
              f"window={window_size_s or total_s:.1f}s, "
              f"step={step_s or (window_size_s or total_s):.1f}s, "
              f"total windows={len(windows)}")
        print(f"  [SUMMARY] Features per window: "
              f"{n_bands} bands x {n_stats} stats x {n_channels} channels = {feature_count}")

        for i, w in enumerate(windows):
            if i >= MAX_PRINT:
                print(f"\n  [SUMMARY] ... ({len(windows) - MAX_PRINT} more windows — "
                      f"change MAX_PRINT to see more)")
                break
            print(f"\n  [SUMMARY] Window {i} "
                  f"[{w['time_start']:.1f}s - {w['time_end']:.1f}s]:")
            print(f"    {'':<12}| {'mean':>8} | {'std':>8} | {'peak':>8}")
            print(f"    {'-' * 12}|{'-' * 10}|{'-' * 10}|{'-' * 10}")
            for ch in settings.CHANNELS:
                for band, stats in w["features"][ch].items():
                    print(f"    {ch + '.' + band:<12}"
                          f"| {stats['mean']:>8.3f} "
                          f"| {stats['std']:>8.3f} "
                          f"| {stats['peak']:>8.3f}")
                print(f"    {'-' * 12}|{'-' * 10}|{'-' * 10}|{'-' * 10}")

        print(f"\n  [SUMMARY] Total features per window: {feature_count} "
              f"({'✓' if feature_count == 60 else '✗ expected 60'})")

        # Verify structure
        assert len(windows) > 0
        assert feature_count == 60
        w = windows[0]
        for ch in settings.CHANNELS:
            bands = w["features"][ch]
            assert set(bands.keys()) == {"delta", "theta", "alpha", "beta", "gamma"}
            for band_stats in bands.values():
                assert set(band_stats.keys()) == {"mean", "std", "peak"}


# ── ORIGINAL FFT/WELCH VERSION — kept as fallback per project decision ────────
#
# class TestFeaturesOnRealSession:
#     def test_full_feature_extraction_on_real_window(self, db_conn, session_id):
#         """
#         Run preprocessing pipeline on real session, then extract every
#         feature from the first clean window — full chain in one place,
#         all in one place for a final sanity check.
#         """
#         signals = _first_real_window(db_conn, session_id)
#
#         psd_results = compute_psd_multichannel(signals)
#         band_powers = all_band_powers_multichannel(psd_results)
#         ratios      = all_ratios_multichannel(band_powers)
#         faa         = frontal_alpha_asymmetry_from_bandpowers(band_powers)
#
#         print(f"\n  [SUMMARY] Band powers per channel:")
#         for ch, bp in band_powers.items():
#             print(f"    {ch}: " + ", ".join(f"{band}={val:.2f}" for band, val in bp.items()))
#
#         print(f"  [SUMMARY] Ratios per channel:")
#         for ch, r in ratios.items():
#             print(f"    {ch}: TBR={r['theta_beta_ratio']:.2f}, ABR={r['alpha_beta_ratio']:.2f}")
#
#         print(f"  [SUMMARY] Frontal asymmetry : {faa:.4f}")
#
#         assert set(band_powers.keys()) == {"fp1", "fp2", "t3", "t4"}
#         assert isinstance(faa, float)
