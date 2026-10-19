"""
tests/test_phase1_models.py

Every algorithm in the registry must honour the same contract, because evaluate.py,
train.py and inference.py treat them as interchangeable. Synthetic data only — no
database.
"""

import joblib
import numpy as np
import pytest
from sklearn.base import clone

from app.phase1 import evaluate, models
from app.tests.test_phase1_harness import _synth

ALL = models.names()


def _build(name):
    """Skip, rather than fail, where an optional library is not installed."""
    try:
        return models.build(name)
    except models.ModelUnavailable as exc:
        pytest.skip(str(exc))


def test_registry_holds_the_baseline_and_both_tiers():
    assert set(ALL) == {"ridge", "random_forest", "svm", "xgboost", "mlp"}


def test_unknown_name_is_rejected_with_the_choices():
    with pytest.raises(ValueError, match="Unknown model 'nope'"):
        models.build("nope")


def test_make_models_leaves_out_a_model_whose_library_is_missing(monkeypatch):
    """One absent optional library must not take the whole comparison down."""
    def unavailable():
        raise models.ModelUnavailable("not installed")

    monkeypatch.setitem(models.REGISTRY, "xgboost", unavailable)
    built = evaluate.make_models()
    assert "xgboost" not in built
    assert "ridge" in built


@pytest.mark.parametrize("name", ALL)
class TestEveryModelHonoursTheContract:

    def test_predicts_valence_and_arousal_together(self, name):
        X, y, _, _ = _synth(20, 6, "learnable")
        model = _build(name).fit(X, y)
        pred = np.asarray(model.predict(X[:7]))
        assert pred.shape == (7, 2)
        assert np.all(np.isfinite(pred))

    def test_builds_a_fresh_model_every_time(self, name):
        """A shared instance would let one client's fit leak into the next train."""
        assert _build(name) is not _build(name)

    def test_survives_clone(self, name):
        """cross_validate() clones the model once per fold."""
        clone(_build(name))

    def test_round_trips_through_joblib(self, name, tmp_path):
        """train.py saves the fitted model with joblib; inference loads it back."""
        X, y, _, _ = _synth(20, 6, "learnable")
        model = _build(name).fit(X, y)
        path = tmp_path / f"{name}.joblib"
        joblib.dump({"model": model, "algo": name}, path)
        loaded = joblib.load(path)["model"]
        np.testing.assert_allclose(loaded.predict(X), model.predict(X))

    def test_finds_a_real_relationship(self, name):
        """
        The synthetic label is a LINEAR function of 50 features, which suits ridge
        far better than trees — so the bar is "clearly beats the null", not a fixed
        high R². It only has to prove the model learns through the harness at all.
        """
        X, y, groups, sessions = _synth(40, 12, "learnable")
        res = evaluate.cross_validate(X, y, groups, sessions, _build(name), name)
        assert res.beats_null(), res.report()
        assert res.r2["valence"] > 0.2, res.report()
        assert res.r2["arousal"] > 0.2, res.report()

    def test_cannot_score_by_memorising_an_image(self, name):
        """
        The leakage guard must hold for the flexible models too — they are exactly
        the ones that memorise best. Labels are independent of the features, so an
        honest grouped score is ~0 whatever the algorithm.
        """
        X, y, groups, sessions = _synth(30, 15, "fingerprint")
        res = evaluate.cross_validate(X, y, groups, sessions, _build(name), name)
        assert res.r2["valence"] < 0.1, res.report()
        assert res.r2["arousal"] < 0.1, res.report()

    def test_trains_saves_and_serves_through_train_py(self, name, tmp_path, monkeypatch):
        """
        The whole swap, end to end: train_and_save() with this algorithm writes an
        artifact whose model predicts — which is all inference.py asks of a bundle.
        """
        from app.phase1 import train

        _build(name)
        X, y, groups, sessions = _synth(20, 6, "learnable")
        registered = {}

        monkeypatch.setattr(train, "build_dataset",
                            lambda *a, **k: (X, y, groups, sessions, []))
        monkeypatch.setattr(train.settings, "MODEL_DIR", str(tmp_path))
        monkeypatch.setattr(train.phase1_store, "model_artifacts", lambda *a: [])
        monkeypatch.setattr(train.phase1_store, "insert_model",
                            lambda conn, **kw: registered.update(kw) or 1)

        summary = train.train_and_save(None, "client-1", algo=name, session_ids=["s"])

        assert summary["algo"] == registered["algo"] == name
        assert summary["cv"]["r2"]["valence"] is not None
        bundle = joblib.load(summary["artifact_path"])
        assert bundle["algo"] == name
        pred = np.asarray(bundle["model"].predict(evaluate.per_session_zscore(X, sessions)))
        assert pred.shape == (len(X), 2)


def test_train_rejects_an_unknown_algorithm(monkeypatch):
    from app.phase1 import train

    X, y, groups, sessions = _synth(4, 3, "noise")
    monkeypatch.setattr(train, "build_dataset",
                        lambda *a, **k: (X, y, groups, sessions, []))
    with pytest.raises(ValueError, match="Unknown model 'nope'"):
        train.train_and_save(None, "client-1", algo="nope", session_ids=["s"])
