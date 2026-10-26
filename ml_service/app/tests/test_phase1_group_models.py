"""
tests/test_phase1_group_models.py

Phase 1 models belong to GROUPS of clients (migration 025). No database needed: these
pin the contract (group required, SQL scoping), the leave-one-person-out score, and
that the BFI-2 inputs actually reach the model in training and inference.
"""

import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import numpy as np
import pytest
from sklearn.base import BaseEstimator, RegressorMixin

from app.api.insights import GroupTrainRequest
from app.phase1 import evaluate, inference, train
from app.workers import prediction_jobs

BFI = {"E": 3.5, "A": 4.0, "C": 2.5, "N": 1.5, "O": 4.5}


def test_group_train_request_predicts_by_default():
    assert GroupTrainRequest().predict is True


def test_cli_train_requires_group(monkeypatch, capsys):
    from scripts import phase1_cli
    monkeypatch.setattr(sys, "argv", ["phase1_cli", "--train"])
    with pytest.raises(SystemExit) as exc:
        phase1_cli.main()
    assert exc.value.code != 0
    assert "--group" in capsys.readouterr().err


def test_pending_sessions_needs_a_group_model_for_the_client():
    conn = MagicMock()
    conn.execute.return_value.mappings.return_value.all.return_value = [{"session_id": "s1"}]
    out = prediction_jobs.pending_sessions(conn)
    sql = str(conn.execute.call_args[0][0])
    assert "ml_group_members" in sql and "m.is_current" in sql
    assert "gm.client_id = s.client_id" in sql
    assert out == ["s1"]


# ── Leave-one-person-out cross-validation ────────────────────────────────────────

def _people_dataset(n_people=4, n_images=12, epochs_per_image=3, signal=True, seed=0):
    """Every person sees the same images (as on the real protocol)."""
    rng = np.random.default_rng(seed)
    labels = rng.uniform(2, 6, size=(n_images, 2))
    rows, y, images, people = [], [], [], []
    for p in range(n_people):
        for i in range(n_images):
            for _ in range(epochs_per_image):
                noise = rng.normal(0, 0.1, size=4)
                feat = (np.r_[labels[i], labels[i]] if signal else rng.normal(0, 1, 4)) + noise
                rows.append(feat)
                y.append(labels[i])
                images.append(f"img{i}")
                people.append(f"p{p}")
    X = np.array(rows)
    bfi = np.repeat(rng.uniform(1, 5, size=(n_people, 5)), n_images * epochs_per_image, axis=0)
    return X, bfi, np.array(y), np.array(images, dtype=object), np.array(people, dtype=object)


def test_people_cv_finds_a_real_signal():
    X, bfi, y, images, people = _people_dataset(signal=True)
    res = evaluate.cross_validate_people(X, bfi, y, images, people, evaluate.make_models()["random_forest"])
    assert res.n_people == 4
    assert res.n_folds == 4 * 5
    assert res.r2_no_bfi["valence"] > res.null_r2["valence"] + 0.3


class _ImageMemoriser(BaseEstimator, RegressorMixin):
    """Predicts a test row's label only if the SAME image was in training — i.e. only
    if the split leaked it. Feature 0 carries the image index."""

    def fit(self, X, y):
        self.table_ = {round(float(x0)): yy for x0, yy in zip(X[:, 0], y)}
        self.mean_ = y.mean(axis=0)
        return self

    def predict(self, X):
        return np.array([self.table_.get(round(float(x0)), self.mean_) for x0 in X[:, 0]])


def test_people_cv_never_trains_on_the_test_images():
    X, bfi, y, images, people = _people_dataset(signal=False)
    X[:, 0] = [int(i[3:]) for i in images]   # feature 0 = image identity
    res = evaluate.cross_validate_people(X, bfi, y, images, people, _ImageMemoriser())
    # A leaked image would be predicted exactly (R² near 1); held out, the memoriser
    # can only fall back to the training mean, i.e. the null.
    assert res.r2_no_bfi["valence"] == pytest.approx(res.null_r2["valence"], abs=1e-9)


def test_people_cv_needs_two_people():
    X, bfi, y, images, people = _people_dataset(n_people=1)
    with pytest.raises(ValueError):
        evaluate.cross_validate_people(X, bfi, y, images, people, evaluate.make_models()["random_forest"])


# ── BFI reaches the model ─────────────────────────────────────────────────────────

class _Recorder(BaseEstimator, RegressorMixin):
    fitted_X = None

    def fit(self, X, y):
        _Recorder.fitted_X = X
        return self

    def predict(self, X):
        _Recorder.predicted_X = X
        return np.full((len(X), 2), 4.0)


def test_training_appends_bfi_after_per_session_zscoring(monkeypatch, tmp_path):
    members = [
        {"client_id": "c1", "client_name": "A", "session_id": "s1", "start_time": None, "bfi": BFI},
        {"client_id": "c2", "client_name": "B", "session_id": "s2", "start_time": None,
         "bfi": {**BFI, "E": 1.0}},
    ]
    monkeypatch.setattr(train, "resolve_members", lambda conn, gid: ([dict(m) for m in members], []))
    X, _, y, images, people = _people_dataset(n_people=2, n_images=6)
    sessions = np.array(["s1" if p == "p0" else "s2" for p in people], dtype=object)
    monkeypatch.setattr(train, "build_dataset", lambda *a, **k: (X, y, images, sessions, []))
    monkeypatch.setattr(train, "_log_extraction", lambda *a, **k: None)
    monkeypatch.setattr(train, "_prune_artifacts", lambda *a, **k: 0)
    monkeypatch.setattr(train.evaluate, "make_models", lambda: {"random_forest": _Recorder()})
    monkeypatch.setattr(train.settings, "MODEL_DIR", str(tmp_path))
    inserted = {}
    monkeypatch.setattr(train.phase1_store, "insert_model",
                        lambda conn, **kw: inserted.update(kw) or 42)

    out = train.train_group_and_save(MagicMock(), "g1")

    assert out["trained"] and out["model_version"] == 42
    fitted = _Recorder.fitted_X
    assert fitted.shape[1] == X.shape[1] + 5
    # The BFI columns survive as the raw domain means (not z-scored to zero).
    assert np.allclose(fitted[sessions == "s1", -5:], [BFI[d] for d in "EACNO"])
    assert np.allclose(fitted[sessions == "s2", -5], 1.0)
    assert inserted["n_clients"] == 2
    assert {m["session_id"] for m in inserted["members"]} == {"s1", "s2"}
    # Each member's own held-out score is kept for comparing newcomers with the group.
    assert all(set(m["cv"]["mae"]) == {"valence", "arousal"} for m in inserted["members"])


def test_training_refuses_a_group_with_one_usable_member(monkeypatch):
    monkeypatch.setattr(train, "resolve_members", lambda conn, gid: (
        [{"client_id": "c1", "client_name": "A", "session_id": "s1", "start_time": None, "bfi": BFI}],
        [{"client_id": "c2", "client_name": "B", "reason": "no complete BFI-2 questionnaire"}],
    ))
    out = train.train_group_and_save(MagicMock(), "g1")
    assert out["trained"] is False
    assert out["skipped"][0]["reason"] == "no complete BFI-2 questionnaire"


def _fake_epochs(n=6):
    t0 = datetime(2026, 8, 1, tzinfo=timezone.utc)
    from app.phase1.epochs import Epoch
    return [Epoch(session_id="s1", image_id="i1", event_id="e1", t_start=t0 + timedelta(seconds=i),
                  t_end=t0 + timedelta(seconds=i + 2), signals={}, valence=4.0, arousal=3.0,
                  valence_sd=1.0, arousal_sd=1.0) for i in range(n)]


def test_inference_appends_the_clients_bfi(monkeypatch):
    rng = np.random.default_rng(1)
    monkeypatch.setattr(inference, "extract_session_epochs", lambda *a, **k: (_fake_epochs(), None))
    monkeypatch.setattr(inference, "build_features", lambda e, cfg: rng.normal(size=10))
    monkeypatch.setattr(inference.queries, "fetch_session_client", lambda conn, sid: "c1")
    monkeypatch.setattr(inference.queries, "fetch_client_bfi", lambda conn, cid, sid: {**BFI, "session_id": "s1"})
    bundle = {"model": _Recorder(), "uses_bfi": True, "bfi_domains": list("EACNO")}

    rows = inference.predict_session(MagicMock(), "s1", bundle, 7)

    assert len(rows) == 6
    assert _Recorder.predicted_X.shape[1] == 15
    assert np.allclose(_Recorder.predicted_X[:, -5:], [BFI[d] for d in "EACNO"])


def test_inference_skips_a_client_without_bfi(monkeypatch):
    monkeypatch.setattr(inference, "extract_session_epochs", lambda *a, **k: (_fake_epochs(), None))
    monkeypatch.setattr(inference, "build_features", lambda e, cfg: np.zeros(10))
    monkeypatch.setattr(inference.queries, "fetch_session_client", lambda conn, sid: "c1")
    monkeypatch.setattr(inference.queries, "fetch_client_bfi", lambda conn, cid, sid: None)
    bundle = {"model": _Recorder(), "uses_bfi": True}
    assert inference.predict_session(MagicMock(), "s1", bundle, 7) == []
