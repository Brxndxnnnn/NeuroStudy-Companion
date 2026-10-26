"""
tests/test_phase1_group_fit.py

Comparing a client with a trained group (phase1/group_fit.py). No database needed: these
pin the scoring frame (members left out the same way as the client), that the response
score never trains on the client or their test images, and the refusals.
"""

from unittest.mock import MagicMock

import numpy as np
import pytest

from app.phase1 import evaluate, group_fit
from app.tests.test_phase1_group_models import _ImageMemoriser, _people_dataset

BFI = {"E": 3.0, "A": 3.5, "C": 4.0, "N": 2.0, "O": 3.5}


# ── Shared scoring ─────────────────────────────────────────────────────────────

def test_distance_is_rms_of_z_scores():
    ref = np.array([[0.0, 0.0], [2.0, 2.0]])          # mean 1, sd 1 on both features
    d, z = group_fit.distance(np.array([3.0, 1.0]), ref, sd_floor=0.1)
    assert np.allclose(z, [2.0, 0.0])
    assert d == pytest.approx(np.sqrt(2.0))


def test_distance_floor_keeps_identical_members_finite():
    ref = np.array([[3.0] * 5, [3.0] * 5])            # everyone answered 3
    d, z = group_fit.distance(np.array([3.5] * 5), ref, sd_floor=0.25)
    assert np.isfinite(d) and d == pytest.approx(2.0)


def test_members_are_scored_against_the_others_only():
    ref = np.array([[0.0], [0.0], [10.0]])
    d = group_fit.leave_one_out_distances(ref, sd_floor=1.0)
    # The outlier, measured against the two at 0 (spread floored to 1), is 10 out.
    assert d[2] == pytest.approx(10.0)
    assert d[0] == d[1] and d[0] < d[2]


def test_placement():
    p = group_fit.placement(1.0, [0.5, 1.5, 2.0])
    assert p == {"within_range": True, "members_further": 2, "n_members": 3}
    assert group_fit.placement(3.0, [0.5, 1.5, 2.0])["within_range"] is False


# ── Personality ────────────────────────────────────────────────────────────────

def _members(bfis):
    return [{"client_id": f"c{i}", "client_name": f"M{i}", "bfi": b} for i, b in enumerate(bfis)]


def test_personality_within_and_outside_the_range():
    members = _members([BFI, {**BFI, "N": 2.5}, {**BFI, "E": 3.5}])
    close = group_fit.compare_personality({**BFI, "N": 2.2}, members)
    far = group_fit.compare_personality({d: 5.0 for d in "EACNO"}, members)
    assert close["available"] and close["placement"]["within_range"]
    assert not far["placement"]["within_range"]
    assert [d["domain"] for d in far["domains"]] == list("EACNO")
    assert len(far["members"]) == 3


def test_two_members_are_compared_but_not_used_as_a_range():
    out = group_fit.compare_personality({**BFI, "N": 4.0}, _members([BFI, {**BFI, "E": 4.0}]))
    assert out["available"] and out["placement"] is None and out["members"] == []
    assert out["distance"] > 0 and len(out["domains"]) == 5


def test_personality_needs_the_clients_bfi():
    out = group_fit.compare_personality(None, _members([BFI, BFI]))
    assert out["available"] is False and "BFI-2" in out["reason"]


# ── EEG profile ────────────────────────────────────────────────────────────────

def test_band_shares_are_percent_of_each_channel():
    rng = np.random.default_rng(0)
    powers = rng.uniform(1, 10, size=(40, 4, 5))
    shares = group_fit.band_shares(powers).reshape(4, 5)
    # Medians of per-window shares need not sum to exactly 100, but stay close.
    assert np.all(shares > 0) and np.allclose(shares.sum(axis=1), 100, atol=10)


def test_band_shares_need_enough_windows():
    assert group_fit.band_shares(np.ones((5, 4, 5))) is None


def test_eeg_profile_names_every_channel_and_band():
    rng = np.random.default_rng(1)
    members = [{"client_id": f"c{i}", "client_name": f"M{i}",
                "shares": rng.uniform(5, 40, 20)} for i in range(3)]
    out = group_fit.compare_eeg_profile(rng.uniform(5, 40, 20), members)
    assert out["available"] and len(out["features"]) == 20
    assert out["features"][0]["channel"] == "FP1" and out["features"][0]["band"] == "delta"


# ── Response ───────────────────────────────────────────────────────────────────

def _split_newcomer(X, bfi, y, images, people, newcomer="p3"):
    c = people == newcomer
    return (X[~c], bfi[~c], y[~c], images[~c]), (X[c], bfi[c], y[c], images[c])


def test_response_score_finds_a_real_signal():
    X, bfi, y, images, people = _people_dataset(signal=True)
    members, client = _split_newcomer(X, bfi, y, images, people)
    res = group_fit.score_newcomer(*members, *client, evaluate.make_models()["random_forest"])
    assert res["r2"]["valence"] > 0.3
    assert res["n_epochs"] == len(client[0])


def test_response_score_never_trains_on_the_clients_test_images():
    X, bfi, y, images, people = _people_dataset(signal=False)
    X[:, 0] = [int(i[3:]) for i in images]           # feature 0 = image identity
    members, client = _split_newcomer(X, bfi, y, images, people)
    res = group_fit.score_newcomer(*members, *client, _ImageMemoriser())
    # A leaked image would be predicted exactly (error 0); held out, the memoriser can
    # only fall back to the training mean.
    assert res["mae"]["valence"] > 0.5


def test_cross_validation_keeps_each_persons_own_score():
    X, bfi, y, images, people = _people_dataset(signal=True)
    res = evaluate.cross_validate_people(X, bfi, y, images, people,
                                         evaluate.make_models()["random_forest"])
    assert set(res.per_person) == {"p0", "p1", "p2", "p3"}
    assert sum(p["n_epochs"] for p in res.per_person.values()) == res.n_epochs
    assert set(res.per_person["p0"]["mae"]) == {"valence", "arousal"}


def test_response_asks_for_a_retrain_when_members_have_no_scores():
    members = [{"client_id": "c1", "client_name": "A", "session_id": "s1", "bfi": BFI,
                "cv_mae_valence": None, "cv_mae_arousal": None}] * 2
    out = group_fit.compare_response(MagicMock(), {"session_id": "s9"}, BFI, members, None)
    assert out["available"] is False and "Retrain" in out["reason"]


# ── Refusals ───────────────────────────────────────────────────────────────────

def _wire(monkeypatch, *, model=True, client_clinic="k1", members=("c1", "c2")):
    monkeypatch.setattr(group_fit.queries, "fetch_group",
                        lambda conn, gid: {"group_id": gid, "clinic_id": "k1", "name": "G"})
    monkeypatch.setattr(group_fit.phase1_store, "current_model",
                        lambda conn, gid: {"model_version": 7} if model else None)
    monkeypatch.setattr(group_fit.queries, "fetch_client",
                        lambda conn, cid: {"client_id": cid, "client_name": "New",
                                           "clinic_id": client_clinic})
    monkeypatch.setattr(group_fit.phase1_store, "model_members", lambda conn, ver: [
        {"client_id": c, "client_name": c, "session_id": f"s-{c}"} for c in members])


def test_refuses_a_group_without_a_model(monkeypatch):
    _wire(monkeypatch, model=False)
    with pytest.raises(group_fit.FitError) as e:
        group_fit.compare_client(MagicMock(), "g1", "c9")
    assert e.value.status == 404


def test_refuses_one_of_the_models_own_members(monkeypatch):
    _wire(monkeypatch)
    with pytest.raises(group_fit.FitError) as e:
        group_fit.compare_client(MagicMock(), "g1", "c1")
    assert e.value.status == 400 and "trained on" in e.value.message


def test_refuses_a_client_from_another_clinic(monkeypatch):
    _wire(monkeypatch, client_clinic="k2")
    with pytest.raises(group_fit.FitError) as e:
        group_fit.compare_client(MagicMock(), "g1", "c9")
    assert e.value.status == 400
