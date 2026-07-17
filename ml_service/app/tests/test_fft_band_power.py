"""
tests/test_fft_band_power.py

Correctness of the FFT band-power computation — the numbers, not just the wiring.

These pin the physics: a signal of known power must produce band powers of the right
MAGNITUDE in the right band, in µV². The reference facts:

  * A sinusoid of amplitude A has power A²/2.
  * Parseval: integrating a correctly-normalised PSD over all frequency recovers the
    signal's variance. For a broadband signal (real EEG), band powers therefore sum to
    the signal variance.

Pure sinusoids sit slightly off because a Hann-windowed discrete spectrum leaks a line
across neighbouring bins (~10% on a bin-centred tone); real EEG is broadband and does
not, so the broadband/white-noise checks below use tight tolerances and the pure-tone
checks use loose ones. That split is deliberate — it is the actual behaviour of the
estimator, verified in review.
"""

import numpy as np
import pytest
from datetime import datetime, timezone, timedelta

from app.feature_extraction.fft_band_power import fft_band_powers_sliding
from app.feature_extraction.psd import compute_psd
from app.feature_extraction.bandpower import all_band_powers, BANDS

FS = 250


def _tone(freq, amp, seconds=8.0):
    t = np.arange(int(FS * seconds)) / FS
    return amp * np.sin(2 * np.pi * freq * t)


def _bands(sig):
    return all_band_powers(*compute_psd(sig, fs=FS))


class TestBandPowerMagnitude:

    def test_pure_tone_lands_in_the_right_band_at_the_right_power(self):
        """20 µV, 10 Hz → ~all power in alpha, ≈ A²/2 = 200 µV²."""
        b = _bands(_tone(10, 20))
        assert max(b, key=b.get) == "alpha"
        assert b["alpha"] == pytest.approx(200, rel=0.15)
        # every other band is essentially empty
        for name in ("delta", "theta", "beta", "gamma"):
            assert b[name] < 0.01 * b["alpha"]

    def test_multitone_recovers_each_bands_power(self):
        """Independent tones in three bands each recover ≈ A²/2."""
        sig = _tone(6, 10) + _tone(10, 14) + _tone(20, 30)   # theta50 alpha98 beta450
        b = _bands(sig)
        assert b["theta"] == pytest.approx(50, rel=0.20)
        assert b["alpha"] == pytest.approx(98, rel=0.20)
        assert b["beta"] == pytest.approx(450, rel=0.20)
        assert b["delta"] < 1.0 and b["gamma"] < 1.0

    def test_units_are_uV_squared_scaling_with_amplitude(self):
        """Doubling amplitude quadruples power (power ∝ A²)."""
        p1 = _bands(_tone(10, 10))["alpha"]
        p2 = _bands(_tone(10, 20))["alpha"]
        assert p2 / p1 == pytest.approx(4.0, rel=0.05)


class TestParsevalNormalisation:

    def test_broadband_power_sums_to_variance(self):
        """
        The real correctness proof: on a broadband signal (a stand-in for EEG, which has
        no line spectra) the full-spectrum PSD integral equals the signal variance. This
        is what certifies the µV² normalisation — independent of any band edges.
        """
        rng = np.random.default_rng(0)
        sig = rng.standard_normal(int(FS * 30)) * 15.0
        from scipy.integrate import simpson
        freqs, psd = compute_psd(sig, fs=FS)
        assert simpson(psd, freqs) == pytest.approx(np.var(sig), rel=0.05)


class TestSlidingAndGaps:

    def _times(self, n, t0=None):
        t0 = t0 or datetime(2026, 1, 1, tzinfo=timezone.utc)
        return [t0 + timedelta(seconds=i / FS) for i in range(n)]

    def test_windows_carry_absolute_centre_times_and_all_channels(self):
        sig = _tone(10, 20, seconds=6.0)
        signals = {ch: sig.copy() for ch in ("fp1", "fp2", "t3", "t4")}
        wins = fft_band_powers_sliding(signals, self._times(len(sig)),
                                       window_size_s=2.0, step_s=0.5)
        assert len(wins) == 9                       # floor((6-2)/0.5)+1
        assert set(wins[0]["powers"]) == {"fp1", "fp2", "t3", "t4"}
        assert isinstance(wins[0]["time"], datetime)
        # centres are strictly increasing
        centres = [w["time"] for w in wins]
        assert centres == sorted(centres)

    def test_windows_straddling_a_dropout_are_dropped(self):
        """A window whose samples span a Bluetooth gap is not one contiguous window."""
        sig = _tone(10, 20, seconds=6.0)
        n = len(sig)
        signals = {ch: sig.copy() for ch in ("fp1", "fp2", "t3", "t4")}
        times = self._times(n)
        for i in range(n // 2, n):          # a 5 s jump mid-session
            times[i] = times[i] + timedelta(seconds=5)
        contiguous = fft_band_powers_sliding(signals, self._times(n),
                                             window_size_s=2.0, step_s=0.5)
        gapped = fft_band_powers_sliding(signals, times,
                                         window_size_s=2.0, step_s=0.5)
        assert len(gapped) < len(contiguous)

    def test_times_length_must_match_signals(self):
        signals = {ch: _tone(10, 20, seconds=4.0) for ch in ("fp1", "fp2", "t3", "t4")}
        with pytest.raises(ValueError, match="same rows"):
            fft_band_powers_sliding(signals, self._times(10),
                                    window_size_s=2.0, step_s=0.5)
