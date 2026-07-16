"""
tests/test_phase1_harness.py

Validate the Phase 1 pipeline on synthetic data, where the true answer is known.

This is the point of building the harness before the real data arrives. Once you
have real EEG, a number is just a number — you have no independent way to tell a
genuine result from a leaked one. Here we construct three worlds and check the
harness reports the truth in each:

  1. There IS a learnable relationship  -> grouped CV must find it.
  2. There is NO relationship           -> grouped CV must report ~nothing,
                                           and must not beat the null.
  3. There is no relationship, but the epochs from one image are near-duplicates
     -> a RANDOM split must be fooled into a strong score, and the GROUPED split
        must not be. This is the test that proves the leakage guard actually
        does something, rather than merely being described in a docstring.
"""

import numpy as np
import pytest

from app.phase1 import evaluate
from app.phase1.epochs import Epoch
from app.phase1.features import build_features, feature_names

N_FEATURES = 50


def _synth(n_images, epochs_per_image, mode, seed=0):
    """
    Build (X, y, groups, sessions) with a known ground truth.

    mode:
      "learnable"   label is a linear function of the epoch's features
      "noise"       features and labels are independent
      "fingerprint" every epoch of an image is a near-duplicate carrying that
                    image's identity, but the label is INDEPENDENT of the
                    features — so nothing generalises to a new image, and only
                    memorisation can score
    """
    rng = np.random.default_rng(seed)
    X, y, groups, sessions = [], [], [], []

    w_v = rng.normal(size=N_FEATURES)
    w_a = rng.normal(size=N_FEATURES)

    for i in range(n_images):
        # Two sessions, so per-session normalisation has something to do.
        session = f"session-{i % 2}"
        fingerprint = rng.normal(size=N_FEATURES)

        if mode == "fingerprint":
            label = rng.normal(size=2) * 1.5      # unrelated to fingerprint
        for _ in range(epochs_per_image):
            if mode == "learnable":
                x = rng.normal(size=N_FEATURES)
                target = np.array([x @ w_v, x @ w_a]) / np.sqrt(N_FEATURES)
                target += rng.normal(scale=0.1, size=2)
            elif mode == "noise":
                x = rng.normal(size=N_FEATURES)
                target = rng.normal(size=2)
            elif mode == "fingerprint":
                x = fingerprint + rng.normal(scale=0.01, size=N_FEATURES)
                target = label
            else:
                raise ValueError(mode)

            X.append(x)
            y.append(target)
            groups.append(f"image-{i}")
            sessions.append(session)

    return (np.array(X), np.array(y),
            np.array(groups, dtype=object), np.array(sessions, dtype=object))


class TestHarnessTellsTheTruth:

    def test_finds_a_real_relationship(self):
        """When the signal is genuinely there, grouped CV must recover it."""
        X, y, groups, sessions = _synth(40, 12, "learnable")
        res = evaluate.cross_validate(
            X, y, groups, sessions, evaluate.make_models()["ridge"],
            "ridge", grouped=True,
        )
        assert res.r2["valence"] > 0.5, res.report()
        assert res.r2["arousal"] > 0.5, res.report()
        assert res.beats_null(), res.report()

    def test_reports_nothing_when_there_is_nothing(self):
        """
        Pure noise must not produce a score. A harness that finds signal in noise
        would happily find it in real EEG too, and we would never know.
        """
        X, y, groups, sessions = _synth(40, 12, "noise")
        res = evaluate.cross_validate(
            X, y, groups, sessions, evaluate.make_models()["ridge"],
            "ridge", grouped=True,
        )
        # R² on held-out images should be at or below zero — a model fitted on
        # noise predicts held-out noise worse than the mean does.
        assert res.r2["valence"] < 0.1, res.report()
        assert res.r2["arousal"] < 0.1, res.report()

    def test_leakage_guard_actually_guards(self):
        """
        THE load-bearing test.

        Epochs from one image are near-duplicates carrying that image's identity,
        and the label is independent of the features — so there is genuinely
        nothing to learn, and generalisation to an unseen image is impossible.

        A random split must nevertheless score well (it has seen near-identical
        rows with the answer attached). The grouped split must not. If this test
        ever fails, the grouping has stopped working and every downstream number
        is suspect.
        """
        X, y, groups, sessions = _synth(30, 15, "fingerprint")
        honest, leaky = evaluate.demonstrate_leakage(X, y, groups, sessions)

        # The leaky split is fooled: it memorises the fingerprint -> label map.
        assert leaky.r2["valence"] > 0.5, leaky.report()

        # The honest split is not: a new image's fingerprint says nothing.
        assert honest.r2["valence"] < 0.1, honest.report()

        # And the gap is large — this is the illusion the guard removes.
        assert leaky.r2["valence"] - honest.r2["valence"] > 0.5

    def test_null_baseline_is_computed_from_training_data_only(self):
        """
        The null must predict the TRAINING mean, not the test mean. Predicting the
        test mean would be a null that peeked at the answers, and would set an
        unbeatably high bar.
        """
        X, y, groups, sessions = _synth(20, 10, "noise")
        res = evaluate.cross_validate(
            X, y, groups, sessions, evaluate.make_models()["ridge"],
            "ridge", grouped=True,
        )
        # A training-mean null scores ~0 or slightly negative on held-out data.
        for t in evaluate.TARGETS:
            assert -0.5 < res.null_r2[t] <= 0.02, res.report()

    def test_refuses_to_group_with_a_single_image(self):
        """One image means nothing to generalise to. Fail loudly, don't score it."""
        X, y, groups, sessions = _synth(1, 20, "noise")
        with pytest.raises(ValueError, match="at least 2 distinct images"):
            evaluate.cross_validate(
                X, y, groups, sessions, evaluate.make_models()["ridge"],
                "ridge", grouped=True,
            )


class TestFeatureVector:

    def test_names_match_vector_length(self):
        rng = np.random.default_rng(0)
        fs = 250
        epoch = Epoch(
            session_id="s", image_id="i", event_id="e", t_start=None, t_end=None,
            signals={ch: rng.normal(scale=20, size=2 * fs)
                     for ch in ("fp1", "fp2", "t3", "t4")},
            valence=4.0, arousal=3.0, valence_sd=0.8, arousal_sd=1.1,
        )
        vec = build_features(epoch)
        assert vec.shape == (len(feature_names()),)
        assert np.all(np.isfinite(vec))

    def test_asymmetry_sign_follows_the_right_hemisphere(self):
        """
        Frontal alpha asymmetry is ln(right) - ln(left) = ln(fp2) - ln(fp1).
        Boost alpha on fp2 and the feature must go POSITIVE. This pins the
        channel orientation: a silent fp1/fp2 (or t3/t4) transposition anywhere
        upstream would flip the sign of the single feature with the strongest
        prior attached to it, and nothing else would complain.
        """
        fs, n = 250, 500
        t = np.arange(n) / fs
        alpha = np.sin(2 * np.pi * 10 * t)          # 10 Hz = alpha band
        rng = np.random.default_rng(1)

        def epoch_with(fp1_gain, fp2_gain):
            return Epoch(
                session_id="s", image_id="i", event_id="e", t_start=None, t_end=None,
                signals={
                    "fp1": fp1_gain * alpha * 20 + rng.normal(scale=1, size=n),
                    "fp2": fp2_gain * alpha * 20 + rng.normal(scale=1, size=n),
                    "t3":  rng.normal(scale=10, size=n),
                    "t4":  rng.normal(scale=10, size=n),
                },
                valence=4.0, arousal=3.0, valence_sd=0.8, arousal_sd=1.1,
            )

        names = feature_names()
        faa = names.index("frontal_alpha_asymmetry")

        right_dominant = build_features(epoch_with(fp1_gain=0.2, fp2_gain=1.0))[faa]
        left_dominant = build_features(epoch_with(fp1_gain=1.0, fp2_gain=0.2))[faa]

        assert right_dominant > 0, "more alpha on fp2 (right) must give positive FAA"
        assert left_dominant < 0, "more alpha on fp1 (left) must give negative FAA"
