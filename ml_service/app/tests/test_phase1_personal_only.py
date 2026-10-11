"""
tests/test_phase1_personal_only.py

Phase 1 has no shared model: every model belongs to one client. These tests need no
database — they pin the contract (client required, per-client SQL scoping).
"""

import sys
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from app.api.insights import TrainRequest
from app.workers import prediction_jobs


def test_train_request_requires_client_id():
    with pytest.raises(ValidationError):
        TrainRequest()
    assert TrainRequest(client_id="c1").predict is True


def test_cli_train_requires_client(monkeypatch, capsys):
    from scripts import phase1_cli
    monkeypatch.setattr(sys, "argv", ["phase1_cli", "--train"])
    with pytest.raises(SystemExit) as exc:
        phase1_cli.main()
    assert exc.value.code != 0
    assert "--client" in capsys.readouterr().err


def test_pending_sessions_joins_clients_current_model():
    conn = MagicMock()
    conn.execute.return_value.mappings.return_value.all.return_value = [
        {"session_id": "s1", "model_version": 7, "artifact_path": "/m/7.joblib"},
    ]
    out = prediction_jobs.pending_sessions(conn)
    sql = str(conn.execute.call_args[0][0])
    assert "m.client_id = s.client_id" in sql and "m.is_current" in sql
    assert out == [("s1", {"model_version": 7, "artifact_path": "/m/7.joblib"})]


def test_requeue_client_is_scoped_to_one_client():
    conn = MagicMock()
    conn.execute.return_value.all.return_value = [("a",), ("b",)]
    assert prediction_jobs.requeue_client(conn, "c1") == 2
    stmt, params = conn.execute.call_args[0]
    assert "client_id = :cid" in str(stmt)
    assert params == {"cid": "c1"}
