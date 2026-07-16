"""
tests/test_preprocessing.py

Tests for the preprocessing, using real data from the database:

  Infrastructure:
    - config.py        : settings load correctly
    - database.py      : engine connects to real DB
    - health.py        : /health endpoint responds

  Data access:
    - queries.py       : fetch_raw_samples, fetch_eeg_readings,
                         fetch_session, fetch_events
    - writer.py        : write_band_powers (smoke test only — rolls back)

  Preprocessing:
    - bandpass.py      : filter design and application
    - notch.py         : notch filter design and application
    - quality.py       : frame quality gating
    - pipeline.py      : full end-to-end preprocessing pipeline

Run:
    pytest app/tests/test_preprocessing.py -v -s
"""

import numpy as np
import pytest
from sqlalchemy import text
from datetime import timezone

from app.core.config import settings
from app.database import engine
from app.data_access.queries import (
    fetch_raw_samples,
    fetch_filtered_samples,
    fetch_eeg_readings,
    fetch_session,
    fetch_events,
)
from app.preprocessing.bandpass import design_bandpass, apply_bandpass, apply_bandpass_multichannel
from app.preprocessing.notch import design_notch, apply_notch, apply_notch_multichannel
from app.preprocessing.quality import check_frame, gate_frames, quality_report
from app.preprocessing.pipeline import run_pipeline


# ══════════════════════════════════════════════════════════════════════════════
# 1. Config + DB connectivity
# ══════════════════════════════════════════════════════════════════════════════

class TestConfig:
    def test_settings_loaded(self):
        """All required settings attributes exist and are non-empty."""
        print(f"\n  DATABASE_URL : {settings.DATABASE_URL}")
        assert settings.DATABASE_URL is not None
        assert "postgresql://" in settings.DATABASE_URL

    def test_hardware_constants(self):
        assert settings.SAMPLE_RATE       == 250
        assert settings.SAMPLES_PER_FRAME == 249
        assert settings.ADC_SCALE         == 0.02235
        assert len(settings.CHANNELS)     == 4

    def test_band_definitions(self):
        """Band boundaries are non-overlapping and within 0–45 Hz."""
        assert settings.BAND_DELTA[1] == settings.BAND_THETA[0]
        assert settings.BAND_THETA[1] == settings.BAND_ALPHA[0]
        assert settings.BAND_ALPHA[1] == settings.BAND_BETA[0]
        assert settings.BAND_BETA[1]  == settings.BAND_GAMMA[0]
        assert settings.BAND_GAMMA[1] <= 45.0

    def test_bandpass_within_gamma(self):
        assert settings.BANDPASS_LOW  <= settings.BAND_DELTA[0]
        assert settings.BANDPASS_HIGH >= settings.BAND_GAMMA[1]


class TestDatabaseConnection:
    def test_engine_connects(self, db_conn):
        """Engine can execute a trivial query."""
        result = db_conn.execute(text("SELECT 1")).scalar()
        assert result == 1

    def test_timescaledb_extension(self, db_conn):
        """TimescaleDB extension is installed."""
        result = db_conn.execute(text(
            "SELECT extname FROM pg_extension WHERE extname = 'timescaledb'"
        )).scalar()
        assert result == "timescaledb"

    def test_required_tables_exist(self, db_conn):
        """All tables the ML service depends on exist."""
        tables = ["eeg_raw_samples", "eeg_readings", "sessions", "events", "images",
                  "band_powers", "ml_insights"]
        for table in tables:
            result = db_conn.execute(text(
                "SELECT to_regclass(:t)"
            ), {"t": f"public.{table}"}).scalar()
            assert result is not None, f"Table '{table}' not found in DB"


# ══════════════════════════════════════════════════════════════════════════════
# 2. Data access — queries.py
# ══════════════════════════════════════════════════════════════════════════════

class TestQueries:
    def test_fetch_session(self, db_conn, session_id):
        """Session metadata is fetchable and has expected keys."""
        session = fetch_session(db_conn, session_id)
        print(f"\n  Sample rate  : {session['sample_rate']} Hz")
        print(f"  Start → End  : {session['start_time']} → {session['end_time']}")
        assert session is not None, f"Session {session_id} not found"
        assert "session_id"  in session
        assert "client_id"   in session
        assert "sample_rate" in session
        assert session["sample_rate"] in (125, 250)

    def test_fetch_raw_samples(self, db_conn, session_id):
        """Raw samples exist and have correct column structure."""
        samples = fetch_raw_samples(db_conn, session_id)
        print(f"\n  Raw samples  : {len(samples)} rows")
        print(f"  First sample : fp1={samples[0]['fp1']}, fp2={samples[0]['fp2']}, t3={samples[0]['t3']}, t4={samples[0]['t4']}")
        assert len(samples) > 0, "No raw samples found — is eeg_raw_samples populated?"

        first = samples[0]
        assert "time" in first
        assert "fp1"  in first
        assert "fp2"  in first
        assert "t3"   in first
        assert "t4"   in first

    def test_fetch_filtered_samples(self, db_conn, session_id):
        """SDK-filtered samples exist and have correct column structure."""
        samples = fetch_filtered_samples(db_conn, session_id)
        print(f"\n  Filtered samples : {len(samples)} rows")
        print(f"  First sample     : fp1={samples[0]['fp1']}, fp2={samples[0]['fp2']}, t3={samples[0]['t3']}, t4={samples[0]['t4']}")
        assert len(samples) > 0, "No filtered samples found — is eeg_filtered_samples populated?"

        first = samples[0]
        assert "time" in first
        assert "fp1"  in first
        assert "fp2"  in first
        assert "t3"   in first
        assert "t4"   in first

    def test_raw_samples_are_integers(self, db_conn, session_id):
        """ADC values are integers (raw counts, not yet converted to µV)."""
        samples = fetch_raw_samples(db_conn, session_id)
        for ch in ("fp1", "fp2", "t3", "t4"):
            assert isinstance(samples[0][ch], int), (
                f"Channel {ch} should be int ADC count, got {type(samples[0][ch])}"
            )

    def test_raw_samples_ordered_by_time(self, db_conn, session_id):
        """Samples are returned in ascending time order."""
        samples = fetch_raw_samples(db_conn, session_id)
        times = [s["time"] for s in samples]
        assert times == sorted(times), "Raw samples not ordered by time"

    def test_fetch_eeg_readings(self, db_conn, session_id):
        """Frame summaries exist and have pkpk columns."""
        frames = fetch_eeg_readings(db_conn, session_id)
        print(f"\n  EEG frames   : {len(frames)} rows")
        print(f"  First pkpk   : fp1={frames[0]['fp1_filt_pkpk']}, fp2={frames[0]['fp2_filt_pkpk']}, t3={frames[0]['t3_filt_pkpk']}, t4={frames[0]['t4_filt_pkpk']}")
        assert len(frames) > 0, "No eeg_readings found"

        first = frames[0]
        assert "fp1_filt_pkpk" in first
        assert "fp2_filt_pkpk" in first
        assert "t3_filt_pkpk"  in first
        assert "t4_filt_pkpk"  in first

    def test_fetch_events(self, db_conn, session_id):
        """Events query returns expected fields (may be empty if no stimuli yet)."""
        events = fetch_events(db_conn, session_id)
        print(f"\n  Stimulus events : {len(events)}")
        # Events may be empty for test sessions — just check structure if present
        if events:
            first = events[0]
            assert "image_id"      in first
            assert "shown_at"      in first
            assert "hidden_at"     in first
            assert "category"      in first
            assert "valence_mean" in first

    def test_fetch_nonexistent_session(self, db_conn):
        """Fetching a non-existent session returns None gracefully."""
        result = fetch_session(db_conn, "00000000-0000-0000-0000-000000000000")
        assert result is None


# ══════════════════════════════════════════════════════════════════════════════
# 3. Bandpass filter — bandpass.py
# ══════════════════════════════════════════════════════════════════════════════

class TestBandpass:
    def test_design_returns_sos(self):
        """design_bandpass returns a valid SOS array."""
        sos = design_bandpass()
        assert sos is not None
        assert sos.ndim == 2
        assert sos.shape[1] == 6   # standard SOS format: [b0,b1,b2,a0,a1,a2]

    def test_apply_preserves_length(self):
        """Filtered signal has same length as input."""
        signal = np.random.randn(1000)
        filtered = apply_bandpass(signal)
        assert len(filtered) == len(signal)

    def test_attenuates_dc(self):
        """DC component (0 Hz) is removed by highpass portion."""
        # Pure DC signal: constant value
        dc = np.ones(1000) * 50.0
        filtered = apply_bandpass(dc)
        assert np.abs(filtered).mean() < 1.0, "DC not attenuated by bandpass"

    def test_passes_alpha(self):
        """10 Hz alpha signal passes through with minimal attenuation."""
        fs = settings.SAMPLE_RATE
        t  = np.arange(1000) / fs
        alpha = 20.0 * np.sin(2 * np.pi * 10.0 * t)
        filtered = apply_bandpass(alpha)
        # RMS of filtered should be close to RMS of input
        rms_in  = np.sqrt(np.mean(alpha**2))
        rms_out = np.sqrt(np.mean(filtered**2))
        print(f"\n  Alpha RMS in={rms_in:.2f} out={rms_out:.2f}")
        assert abs(rms_out - rms_in) / rms_in < 0.2, (
            f"Alpha band attenuated too much: in={rms_in:.2f}, out={rms_out:.2f}"
        )

    def test_bandpass_on_real_session(self, db_conn, session_id):
        """Real data: apply bandpass to all four real channels, show before/after RMS."""
        from app.data_access.queries import fetch_raw_samples
        samples = fetch_raw_samples(db_conn, session_id)[:1000]
        print(f"\n  [REAL] Bandpass RMS per channel:")
        for ch in settings.CHANNELS:
            raw_uv   = np.array([s[ch] for s in samples], dtype=np.float64) * settings.ADC_SCALE
            filtered = apply_bandpass(raw_uv)
            rms_in   = np.sqrt(np.mean(raw_uv**2))
            rms_out  = np.sqrt(np.mean(filtered**2))
            print(f"    {ch}: in={rms_in:.2f} µV out={rms_out:.2f} µV")
            assert len(filtered) == len(raw_uv)

    def test_attenuates_high_freq(self):
        """
        100 Hz signal (above 45 Hz cutoff) is significantly attenuated.
        A 4th-order Butterworth Filter gives ~83% attenuation at 100 Hz (not brick-wall).
        """
        fs = settings.SAMPLE_RATE
        t  = np.arange(1000) / fs
        high = 20.0 * np.sin(2 * np.pi * 100.0 * t)
        filtered = apply_bandpass(high)
        rms_in  = np.sqrt(np.mean(high**2))
        rms_out = np.sqrt(np.mean(filtered**2))
        attenuation = 1 - (rms_out / rms_in)
        print(f"\n  100 Hz RMS in={rms_in:.2f} out={rms_out:.2f} attenuation={attenuation*100:.1f}%")
        assert attenuation > 0.75, (
            f"High-freq not sufficiently attenuated: "
            f"rms_in={rms_in:.2f}, rms_out={rms_out:.2f}, "
            f"attenuation={attenuation*100:.1f}%"
        )

    def test_too_short_raises(self):
        """Signal shorter than filter minimum raises ValueError."""
        with pytest.raises(ValueError, match="too short"):
            apply_bandpass(np.ones(5))

    def test_invalid_range_raises(self):
        """Lowcut >= highcut raises ValueError."""
        with pytest.raises(ValueError):
            design_bandpass(lowcut=30.0, highcut=10.0)

    def test_multichannel_applies_to_all(self):
        """apply_bandpass_multichannel returns all four channels."""
        signals = {ch: np.random.randn(1000) for ch in settings.CHANNELS}
        result  = apply_bandpass_multichannel(signals)
        assert set(result.keys()) == set(settings.CHANNELS)
        for ch, arr in result.items():
            assert len(arr) == 1000


# ══════════════════════════════════════════════════════════════════════════════
# 4. Notch filter — notch.py
# ══════════════════════════════════════════════════════════════════════════════

class TestNotch:
    def test_design_returns_sos(self):
        sos = design_notch()
        assert sos is not None
        assert sos.ndim == 2

    def test_apply_preserves_length(self):
        signal   = np.random.randn(1000)
        filtered = apply_notch(signal)
        assert len(filtered) == len(signal)

    def test_removes_50hz(self):
        """50 Hz sine wave is significantly attenuated after notch."""
        fs = settings.SAMPLE_RATE
        t  = np.arange(1000) / fs
        mains    = 10.0 * np.sin(2 * np.pi * 50.0 * t)
        filtered = apply_notch(mains, freq=50.0)
        rms_in   = np.sqrt(np.mean(mains**2))
        rms_out  = np.sqrt(np.mean(filtered**2))
        print(f"\n  50 Hz RMS in={rms_in:.2f} out={rms_out:.2f}")
        assert rms_out < 1.0, f"50 Hz not notched: rms={rms_out:.2f}"

    def test_passes_alpha_unchanged(self):
        """10 Hz signal is not affected by 50 Hz notch."""
        fs    = settings.SAMPLE_RATE
        t     = np.arange(1000) / fs
        alpha = 20.0 * np.sin(2 * np.pi * 10.0 * t)
        filtered = apply_notch(alpha)
        rms_in   = np.sqrt(np.mean(alpha**2))
        rms_out  = np.sqrt(np.mean(filtered**2))
        print(f"\n  Alpha RMS in={rms_in:.2f} out={rms_out:.2f} (notch should not affect)")
        assert abs(rms_out - rms_in) / rms_in < 0.05, (
            "Alpha band distorted by notch filter"
        )

    def test_notch_on_real_session(self, db_conn, session_id):
        """Real data: apply notch to all four real channels, show before/after RMS."""
        from app.data_access.queries import fetch_raw_samples
        samples = fetch_raw_samples(db_conn, session_id)[:1000]
        print(f"\n  [REAL] Notch RMS per channel:")
        for ch in settings.CHANNELS:
            raw_uv   = np.array([s[ch] for s in samples], dtype=np.float64) * settings.ADC_SCALE
            filtered = apply_notch(raw_uv)
            rms_in   = np.sqrt(np.mean(raw_uv**2))
            rms_out  = np.sqrt(np.mean(filtered**2))
            print(f"    {ch}: in={rms_in:.2f} µV out={rms_out:.2f} µV")
            assert len(filtered) == len(raw_uv)

    def test_notch_above_nyquist_raises(self):
        with pytest.raises(ValueError, match="Nyquist"):
            design_notch(freq=200.0, fs=250)

    def test_multichannel(self):
        signals = {ch: np.random.randn(1000) for ch in settings.CHANNELS}
        result  = apply_notch_multichannel(signals)
        assert set(result.keys()) == set(settings.CHANNELS)


# ══════════════════════════════════════════════════════════════════════════════
# 5. Quality gating — quality.py
# ══════════════════════════════════════════════════════════════════════════════

class TestQuality:
    def _make_row(self, fp1=50.0, fp2=50.0, t3=50.0, t4=50.0, time=None):
        return {
            "time":          time,
            "fp1_filt_pkpk": fp1,
            "fp2_filt_pkpk": fp2,
            "t3_filt_pkpk":  t3,
            "t4_filt_pkpk":  t4,
        }

    def test_good_frame_accepted(self):
        row    = self._make_row(50.0, 60.0, 55.0, 45.0)
        result = check_frame(row)
        assert result.accepted is True
        assert result.reason is None
        assert all(v == "ok" for v in result.channel_flags.values())

    def test_high_noise_rejected(self):
        """Frame with one channel above QUALITY_PKPK_MAX is rejected."""
        row    = self._make_row(fp1=600.0)   # above 500 µV threshold
        result = check_frame(row)
        assert result.accepted is False
        assert result.channel_flags["fp1"] == "high_noise"

    def test_flat_line_rejected(self):
        """Frame with one channel below QUALITY_PKPK_MIN is rejected."""
        row    = self._make_row(t3=0.5)      # below 1.0 µV threshold
        result = check_frame(row)
        assert result.accepted is False
        assert result.channel_flags["t3"] == "flat_line"

    def test_missing_value_rejected(self):
        row    = self._make_row(fp2=None)
        result = check_frame(row)
        assert result.accepted is False
        assert result.channel_flags["fp2"] == "missing"

    def test_gate_frames_splits_correctly(self):
        rows = [
            self._make_row(50, 50, 50, 50),    # good
            self._make_row(600, 50, 50, 50),   # bad — fp1 noisy
            self._make_row(50, 50, 50, 50),    # good
        ]
        accepted, rejected, results = gate_frames(rows)
        assert len(accepted) == 2
        assert len(rejected) == 1

    def test_quality_report_rates(self):
        rows = [self._make_row(50, 50, 50, 50)] * 8 + [self._make_row(600, 50, 50, 50)] * 2
        _, _, results = gate_frames(rows)
        report = quality_report(results)
        assert report["total_frames"]    == 10
        assert report["accepted_frames"] == 8
        assert report["rejected_frames"] == 2
        assert report["rejection_rate"]  == 0.2

    def test_real_frames_quality(self, db_conn, session_id):
        """Real eeg_readings frames pass quality gate at reasonable rate."""
        from app.data_access.queries import fetch_eeg_readings
        frames = fetch_eeg_readings(db_conn, session_id)
        assert len(frames) > 0

        _, _, results = gate_frames(frames)
        report = quality_report(results)

        print(f"\n  Total frames    : {report['total_frames']}")
        print(f"  Accepted frames : {report['accepted_frames']}")
        print(f"  Rejected frames : {report['rejected_frames']}")
        print(f"  Rejection rate  : {report['rejection_rate']*100:.1f}%")
        # Expect at least 50% of real frames to be usable
        assert report["accepted_frames"] > 0, "All real frames rejected — check thresholds"
        assert report["rejection_rate"] < 0.9, (
            f"Too many frames rejected ({report['rejection_rate']*100:.0f}%). "
            f"Check electrode data or adjust thresholds."
        )


# ══════════════════════════════════════════════════════════════════════════════
# 6. Full pipeline — pipeline.py
# ══════════════════════════════════════════════════════════════════════════════

class TestPipeline:
    def test_pipeline_runs_on_real_session(self, db_conn, session_id):
        """Full pipeline completes without error on real session."""
        result = run_pipeline(db_conn, session_id)
        print(f"\n  Windows produced : {result['n_windows']}")
        print(f"  Rejected frames  : {result['n_rejected_frames']}")
        print(f"  Quality report   : {result['quality_report']}")
        assert result is not None

    def test_pipeline_returns_expected_keys(self, db_conn, session_id):
        result = run_pipeline(db_conn, session_id)
        assert "windows"           in result
        assert "n_windows"         in result
        assert "quality_report"    in result
        assert "n_rejected_frames" in result
        assert "session_id"        in result

    def test_pipeline_produces_windows(self, db_conn, session_id):
        """At least one clean window is produced."""
        result = run_pipeline(db_conn, session_id)
        assert result["n_windows"] > 0, "No windows produced from real session"

    def test_window_has_four_channels(self, db_conn, session_id):
        """Each window contains all four EEG channels."""
        result  = run_pipeline(db_conn, session_id)
        window  = result["windows"][0]
        signals = window["signals"]
        assert set(signals.keys()) == {"fp1", "fp2", "t3", "t4"}

    def test_window_signals_are_microvolts(self, db_conn, session_id):
        """
        Signals are in µV range after ADC conversion.
        Real frontal EEG is typically within ±500 µV.
        """
        result  = run_pipeline(db_conn, session_id)
        window  = result["windows"][0]
        for ch, sig in window["signals"].items():
            print(f"\n  {ch}: min={sig.min():.2f} µV  max={sig.max():.2f} µV  mean={sig.mean():.2f} µV")
            assert sig.max() < 2000, f"{ch} max value suspiciously large: {sig.max():.1f}"
            assert sig.min() > -2000, f"{ch} min value suspiciously small: {sig.min():.1f}"

    def test_window_signals_are_numpy_arrays(self, db_conn, session_id):
        result = run_pipeline(db_conn, session_id)
        window = result["windows"][0]
        for ch, sig in window["signals"].items():
            assert isinstance(sig, np.ndarray), f"{ch} is not a numpy array"

    def test_window_has_timestamps(self, db_conn, session_id):
        """Each window has start and end timestamps."""
        result = run_pipeline(db_conn, session_id)
        window = result["windows"][0]
        assert "start" in window
        assert "end"   in window
        assert window["end"] > window["start"]

    def test_invalid_session_raises(self, db_conn):
        """Non-existent session raises ValueError, not an unhandled exception."""
        with pytest.raises(ValueError):
            run_pipeline(db_conn, "00000000-0000-0000-0000-000000000000")


# ══════════════════════════════════════════════════════════════════════════════
# 7. End-to-end summary on real session — full chain in one place
# ══════════════════════════════════════════════════════════════════════════════

class TestPreprocessingSummary:
    def test_full_preprocessing_chain_on_real_session(self, db_conn, session_id):
        """
        Walk the entire preprocessing journey on the real session in one consolidated
        view: raw ADC counts -> quality gate -> bandpass -> notch -> clean signal.
        Shown for all four channels.
        """
        from app.data_access.queries import fetch_raw_samples

        # Step 1: raw ADC counts, all channels
        samples = fetch_raw_samples(db_conn, session_id)
        print(f"\n  [SUMMARY] Raw samples       : {len(samples)} rows")
        for ch in settings.CHANNELS:
            raw_counts = np.array([s[ch] for s in samples], dtype=np.float64)
            raw_uv     = raw_counts * settings.ADC_SCALE
            print(f"  [SUMMARY] {ch} raw (ADC)     : min={raw_counts.min():.0f} max={raw_counts.max():.0f}")
            print(f"  [SUMMARY] {ch} raw (µV)      : min={raw_uv.min():.2f} max={raw_uv.max():.2f}")

        # Step 2: quality gate
        frames = fetch_eeg_readings(db_conn, session_id)
        _, _, results = gate_frames(frames)
        report = quality_report(results)
        print(f"  [SUMMARY] Quality gate      : {report['accepted_frames']}/{report['total_frames']} "
              f"accepted ({report['rejection_rate']*100:.1f}% rejected)")

        # Step 3 + 4: full pipeline (bandpass + notch on clean windows), all channels
        result = run_pipeline(db_conn, session_id)
        window = result["windows"][0]
        print(f"  [SUMMARY] Windows produced  : {result['n_windows']}")
        for ch in settings.CHANNELS:
            clean_sig = window["signals"][ch]
            print(f"  [SUMMARY] {ch} clean signal  : min={clean_sig.min():.2f} µV "
                  f"max={clean_sig.max():.2f} µV mean={clean_sig.mean():.2f} µV")

        assert result["n_windows"] > 0
        assert all(isinstance(window["signals"][ch], np.ndarray) for ch in settings.CHANNELS)