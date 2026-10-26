"""
tests/test_phase1_train_jobs.py

Group training runs in the background (workers/train_jobs.py, migration 027). No
database needed: these pin that every outcome lands on the group as a status the page
can show, and that a run only ever writes its own status.
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.api import insights
from app.workers import train_jobs

STARTED = datetime(2026, 10, 26, 8, 53, tzinfo=timezone.utc)


@pytest.fixture
def finished(monkeypatch):
    calls = []
    monkeypatch.setattr(train_jobs, "_finish", lambda gid, started, status, result=None, error=None:
                        calls.append({"gid": gid, "started": started, "status": status,
                                      "result": result, "error": error}))
    monkeypatch.setattr(train_jobs, "engine", MagicMock())
    return calls


def test_a_trained_model_is_recorded_as_done_after_its_predictions(monkeypatch, finished):
    order = []
    monkeypatch.setattr(train_jobs.train, "train_group_and_save", lambda conn, gid: {
        "trained": True, "model_version": 28, "artifact_path": "/models/x.joblib", "message": "ok"})
    monkeypatch.setattr(train_jobs.phase1_store, "group_session_ids", lambda conn, gid: ["s1"])
    monkeypatch.setattr(train_jobs.prediction_jobs, "predict_sessions_with_model",
                        lambda summary, sids: order.append("predict") or {"sessions": 1})

    train_jobs.run("g1", STARTED)

    assert order == ["predict"]
    [call] = finished
    assert call["status"] == "done" and call["started"] == STARTED
    assert call["result"]["model_version"] == 28 and call["result"]["inference"] == {"sessions": 1}
    assert "artifact_path" not in call["result"]


def test_not_enough_data_is_done_with_the_reason_not_failed(monkeypatch, finished):
    monkeypatch.setattr(train_jobs.train, "train_group_and_save", lambda conn, gid: {
        "trained": False, "message": "Not enough members can contribute yet.", "skipped": []})
    train_jobs.run("g1", STARTED)
    assert finished[0]["status"] == "done"
    assert finished[0]["result"]["message"].startswith("Not enough")


def test_an_exception_is_recorded_as_failed(monkeypatch, finished):
    def boom(conn, gid):
        raise RuntimeError("database went away")
    monkeypatch.setattr(train_jobs.train, "train_group_and_save", boom)
    train_jobs.run("g1", STARTED)
    assert finished[0]["status"] == "failed"
    assert "database went away" in finished[0]["error"]


def test_claim_refuses_a_group_that_is_already_training():
    conn = MagicMock()
    conn.execute.return_value.first.return_value = None
    assert train_jobs.claim(conn, "g1") is None
    sql = str(conn.execute.call_args[0][0])
    assert "train_status IS DISTINCT FROM 'running'" in sql and "make_interval" in sql


def test_finish_only_writes_its_own_run(monkeypatch):
    conn = MagicMock()
    eng = MagicMock()
    eng.begin.return_value.__enter__.return_value = conn
    monkeypatch.setattr(train_jobs, "engine", eng)
    train_jobs._finish("g1", STARTED, "done", result={"trained": True})
    sql = str(conn.execute.call_args[0][0])
    assert "train_started_at = :started" in sql
    assert conn.execute.call_args[0][1]["started"] == STARTED


def test_endpoint_answers_at_once_and_queues_the_run(monkeypatch):
    conn = MagicMock()
    eng = MagicMock()
    eng.begin.return_value.__enter__.return_value = conn
    monkeypatch.setattr(insights, "engine", eng)
    monkeypatch.setattr(insights.queries, "fetch_group", lambda conn, gid: {"group_id": gid})
    monkeypatch.setattr(insights.train_jobs, "claim", lambda conn, gid: STARTED)
    background = MagicMock()

    out = insights.group_train_endpoint("g1", insights.GroupTrainRequest(), background)

    assert out["status"] == "running" and out["started_at"] == STARTED
    background.add_task.assert_called_once_with(insights.train_jobs.run, "g1", STARTED, True)


def test_endpoint_409_when_already_training(monkeypatch):
    eng = MagicMock()
    monkeypatch.setattr(insights, "engine", eng)
    monkeypatch.setattr(insights.queries, "fetch_group", lambda conn, gid: {"group_id": gid})
    monkeypatch.setattr(insights.train_jobs, "claim", lambda conn, gid: None)
    with pytest.raises(HTTPException) as e:
        insights.group_train_endpoint("g1", insights.GroupTrainRequest(), MagicMock())
    assert e.value.status_code == 409
