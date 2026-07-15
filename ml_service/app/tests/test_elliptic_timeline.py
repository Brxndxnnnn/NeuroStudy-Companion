"""
tests/test_elliptic_timeline.py

Where an elliptic window says it happened.

This was wrong in two independent ways, and both were invisible: the numbers were
plausible, the row count was right, and nothing raised. The only symptom was that a
window described EEG from somewhere else in the session.

  1. The origin was sessions.start_time, which is not when the EEG starts. Across the
     recorded sessions the first sample lands anywhere from -0.3s to +1.2s from it.

  2. Window times came from sample_index / 250 Hz, which assumes a gapless recording.
     The bridge writes REAL gaps where Bluetooth dropped — 13s to 66s per session in
     production. So the error compounded: the late windows of session 1087fe73 were
     landing 51 SECONDS from the EEG they described.

These tests pin the fix by constructing a signal with a known gap and asserting that
windows land on the samples they were computed from.
"""

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from app.core.config import settings
from app.feature_extraction.pipeline import elliptic_sliding_multichannel

FS = settings.SAMPLE_RATE          # 250
T0 = datetime(2026, 7, 15, 12, 0, 0, tzinfo=timezone.utc)
CHANNELS = settings.CHANNELS       # fp1, fp2, t3, t4


def _signals(n, seed=0):
    rng = np.random.default_rng(seed)
    return {ch: rng.normal(scale=20.0, size=n) for ch in CHANNELS}


def _times(n, gap_at=None, gap_s=0.0):
    """Uniform 250 Hz timestamps, optionally with a real dropout before `gap_at`."""
    out = []
    t = T0
    for i in range(n):
        if gap_at is not None and i == gap_at:
            t += timedelta(seconds=gap_s)
        out.append(t)
        t += timedelta(seconds=1 / FS)
    return out


class TestWindowsLandOnTheirOwnSamples:

    def test_window_time_comes_from_the_samples_not_an_offset(self):
        """The first window must start at the first sample, whenever that was."""
        n = 10 * FS
        windows = elliptic_sliding_multichannel(
            _signals(n), window_size_s=1.0, step_s=0.5, times=_times(n)
        )
        assert windows[0]["time_start"] == T0
        assert windows[0]["time_end"] == T0 + timedelta(seconds=1.0)

        # And the Nth window sits exactly N steps along — no accumulated drift.
        assert windows[4]["time_start"] == T0 + timedelta(seconds=2.0)

    def test_a_gap_shifts_later_windows_by_the_real_elapsed_time(self):
        """
        THE BUG, in miniature. A 30s dropout halfway through: windows after it must be
        timestamped 30s later than a naive index/250 would place them. Under the old
        code they carried on as if no time had passed.
        """
        n = 10 * FS
        gap_at = 5 * FS
        times = _times(n, gap_at=gap_at, gap_s=30.0)

        windows = elliptic_sliding_multichannel(
            _signals(n), window_size_s=1.0, step_s=0.5, times=times
        )

        after = [w for w in windows if w["time_start"] >= times[gap_at]]
        assert after, "expected windows after the gap"

        # The first window after the gap starts ~35s in on the WALL CLOCK (5s of
        # signal + a 30s dropout), where index arithmetic would have said ~5s.
        offset = (after[0]["time_start"] - T0).total_seconds()
        assert offset == pytest.approx(35.0, abs=0.01), (
            f"window landed {offset:.2f}s in; index arithmetic would have said ~5s"
        )

    def test_windows_straddling_a_gap_are_dropped(self):
        """
        A window whose samples span a dropout holds the right NUMBER of samples but not
        one contiguous second of EEG. It is not a 1s window and must not be stored as
        one.
        """
        n = 10 * FS
        times = _times(n, gap_at=5 * FS, gap_s=30.0)

        windows = elliptic_sliding_multichannel(
            _signals(n), window_size_s=1.0, step_s=0.5, times=times
        )

        for w in windows:
            span = (w["time_end"] - w["time_start"]).total_seconds()
            assert span == pytest.approx(1.0, abs=0.01), (
                f"a stored window spans {span:.2f}s of wall clock — it straddles the gap"
            )

        # Some windows really were dropped: a gapless run yields more.
        gapless = elliptic_sliding_multichannel(
            _signals(n), window_size_s=1.0, step_s=0.5, times=_times(n)
        )
        assert len(windows) < len(gapless)

    def test_no_drift_accumulates_across_a_long_session(self):
        """The last window must be where the clock says, not where the index says."""
        n = 60 * FS
        times = _times(n)
        windows = elliptic_sliding_multichannel(
            _signals(n), window_size_s=1.0, step_s=0.5, times=times
        )
        last = windows[-1]
        assert last["time_start"] == times[-FS]      # exactly one window from the end
        assert (last["time_end"] - last["time_start"]).total_seconds() == pytest.approx(1.0, abs=0.01)


class TestBackwardCompatibility:

    def test_without_times_it_still_returns_float_offsets(self):
        """
        Synthetic signals in the existing tests have no timeline to honour. That path is
        unchanged — there is no gap to worry about when the array is all there is.
        """
        n = 5 * FS
        windows = elliptic_sliding_multichannel(_signals(n), window_size_s=1.0, step_s=0.5)
        assert isinstance(windows[0]["time_start"], float)
        assert windows[0]["time_start"] == 0.0

    def test_mismatched_times_is_an_error_not_a_silent_misalignment(self):
        n = 5 * FS
        with pytest.raises(ValueError, match="same rows"):
            elliptic_sliding_multichannel(
                _signals(n), window_size_s=1.0, step_s=0.5, times=_times(n - 10)
            )


class TestWriterRejectsOffsets:

    def test_writer_refuses_float_offsets(self):
        """
        The writer used to accept float offsets and rebase them onto start_time — which
        is exactly how the misalignment got in. It must now refuse them loudly rather
        than compute a plausible wrong timestamp.
        """
        from app.data_access.writer import write_elliptic_band_stats

        bands = {b: {"mean": 1.0, "std": 2.0, "peak": 3.0}
                 for b in ("delta", "theta", "alpha", "beta", "gamma")}
        windows = [{
            "time_start": 0.0,          # a float offset — the old shape
            "time_end": 1.0,
            "features": {ch: bands for ch in CHANNELS},
        }]

        with pytest.raises(TypeError, match="ABSOLUTE datetimes"):
            write_elliptic_band_stats(None, "abc", windows, 1.0, 0.5)
