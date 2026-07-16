"""
tests/test_phase1_epochs.py

Epoch extraction, against a fake DB — no connection needed.

The arithmetic here is the thing that quietly decides how much training data the
study produces, so it is pinned down rather than assumed:

  at the REAL 10 s image duration -> 17 epochs per image
  at the 3 s development setting  ->  3 epochs per image

and the rules that keep a training row honest: no epoch may straddle two images,
span a Bluetooth dropout, or come from a dead electrode.
"""

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from app.phase1 import epochs as ep
from app.phase1.config import Phase1Config

FS = 250
T0 = datetime(2026, 7, 15, 12, 0, 0, tzinfo=timezone.utc)


def _samples(n, start=T0, fs=FS, amplitude=20.0, dead=(), gap_at=None, gap_s=0.0):
    """
    A uniform filtered-EEG stream, as the bridge writes it.

    dead:    channels pinned flat (a railed electrode, like T3/T4 on 13 Jul)
    gap_at:  insert a Bluetooth dropout of gap_s seconds before this sample index
    """
    rng = np.random.default_rng(0)
    rows = []
    t = start
    for i in range(n):
        if gap_at is not None and i == gap_at:
            t += timedelta(seconds=gap_s)
        row = {"time": t}
        for ch in ("fp1", "fp2", "t3", "t4"):
            row[ch] = 0.006 if ch in dead else float(rng.normal(scale=amplitude))
        rows.append(row)
        t += timedelta(seconds=1.0 / fs)
    return rows


def _event(shown_at, hidden_at, valence=4.5, arousal=3.2, v_sd=0.8, a_sd=1.0):
    return {
        "event_id": "e1", "image_id": "img-1",
        "shown_at": shown_at, "hidden_at": hidden_at,
        "filename": "Snake 5.jpg", "oasis_theme": "Snake 5",
        "valence_mean": valence, "valence_sd": v_sd,
        "arousal_mean": arousal, "arousal_sd": a_sd,
    }


@pytest.fixture
def fake_db(monkeypatch):
    """Point the queries module at in-memory rows."""
    state = {"samples": [], "events": []}
    monkeypatch.setattr(ep.queries, "fetch_filtered_samples",
                        lambda conn, sid: state["samples"])
    monkeypatch.setattr(ep.queries, "fetch_labelled_image_events",
                        lambda conn, sid: state["events"])
    return state


class TestWindowCount:

    def test_ten_second_image_yields_seventeen_epochs(self, fake_db):
        """floor((10 - 2) / 0.5) + 1 = 17 — the real protocol timing."""
        fake_db["samples"] = _samples(10 * FS)
        fake_db["events"] = [_event(T0, T0 + timedelta(seconds=10))]

        epochs, report = ep.extract_session_epochs(None, "s1")
        assert len(epochs) == 17, report.summary()
        assert all(e.valence == 4.5 and e.arousal == 3.2 for e in epochs)

    def test_three_second_dev_setting_yields_only_three(self, fake_db):
        """
        The cost of recording a training session while IMAGE_DISPLAY_MS is still
        at its 3000 ms development value: a fifth of the data, unrecoverably.
        """
        fake_db["samples"] = _samples(3 * FS)
        fake_db["events"] = [_event(T0, T0 + timedelta(seconds=3))]

        epochs, _ = ep.extract_session_epochs(None, "s1")
        assert len(epochs) == 3

    def test_image_shorter_than_one_window_yields_nothing(self, fake_db):
        fake_db["samples"] = _samples(2 * FS)
        fake_db["events"] = [_event(T0, T0 + timedelta(seconds=1.5))]

        epochs, report = ep.extract_session_epochs(None, "s1")
        assert epochs == []
        assert report.events_too_short == 1


class TestHonestTrainingRows:

    def test_no_epoch_straddles_two_images(self, fake_db):
        """
        Two back-to-back 4 s images. Every epoch must lie entirely within one of
        them — a window spanning the boundary carries EEG from both images but can
        only be given one label, which is a mislabelled training row.
        """
        fake_db["samples"] = _samples(8 * FS)
        a_end = T0 + timedelta(seconds=4)
        fake_db["events"] = [
            {**_event(T0, a_end, valence=2.0), "event_id": "e1", "image_id": "img-A"},
            {**_event(a_end, T0 + timedelta(seconds=8), valence=6.0),
             "event_id": "e2", "image_id": "img-B"},
        ]

        epochs, _ = ep.extract_session_epochs(None, "s1")
        assert len(epochs) == 10          # 5 per image: floor((4-2)/0.5)+1

        cfg = Phase1Config()
        for e in epochs:
            end = e.t_start + timedelta(seconds=cfg.epoch_s)
            if e.image_id == "img-A":
                assert e.valence == 2.0
                assert end <= a_end + timedelta(seconds=0.5 / FS)
            else:
                assert e.valence == 6.0
                assert e.t_start >= a_end - timedelta(seconds=0.5 / FS)

    def test_dead_electrode_is_reported_not_silently_trained_on(self, fake_db):
        """
        A railed electrode (T3/T4, 13 Jul) sits at a constant. It must drop every
        epoch AND be named — a silent zero looks identical to "no data".
        """
        fake_db["samples"] = _samples(10 * FS, dead=("t3",))
        fake_db["events"] = [_event(T0, T0 + timedelta(seconds=10))]

        epochs, report = ep.extract_session_epochs(None, "s1")
        assert epochs == []
        assert "t3" in report.dead_channels
        assert report.epochs_flat_channel == 17
        assert "DEAD CHANNELS" in report.summary()

    def test_epoch_spanning_a_bluetooth_dropout_is_rejected(self, fake_db):
        """
        The bridge writes a REAL timeline with real gaps, so a window can hold the
        right number of samples while spanning several seconds of missing signal.
        Such a window is not 2 s of EEG and must not be treated as one.
        """
        fake_db["samples"] = _samples(10 * FS, gap_at=5 * FS, gap_s=3.0)
        fake_db["events"] = [_event(T0, T0 + timedelta(seconds=13))]

        epochs, report = ep.extract_session_epochs(None, "s1")
        assert report.epochs_gap > 0
        cfg = Phase1Config()
        for e in epochs:
            span = (e.signals["fp1"].shape[0] - 1) / FS
            assert span == pytest.approx(cfg.epoch_s - 1 / FS, abs=1e-6)

    def test_unlabelled_image_is_skipped(self, fake_db):
        """The placeholder images in the DB today: real EEG, no OASIS label."""
        fake_db["samples"] = _samples(10 * FS)
        fake_db["events"] = [_event(T0, T0 + timedelta(seconds=10),
                                    valence=None, arousal=None)]

        epochs, report = ep.extract_session_epochs(None, "s1")
        assert epochs == []
        assert report.events_no_label == 1

    def test_image_the_raters_disagreed_about_is_excluded(self, fake_db):
        """A label nobody agrees on is not a learnable target."""
        fake_db["samples"] = _samples(10 * FS)
        fake_db["events"] = [_event(T0, T0 + timedelta(seconds=10), v_sd=3.5)]

        epochs, report = ep.extract_session_epochs(None, "s1")
        assert epochs == []
        assert report.events_label_too_noisy == 1
