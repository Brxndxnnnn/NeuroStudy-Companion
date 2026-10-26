"""
workers/train_jobs.py

Group training as a background job (migration 027).

Training a group takes minutes on the droplet and grows with every member, so it cannot
run inside the HTTP request: the proxy gives up after a minute and the page reported a
failure while the model was still being trained. Instead the train endpoint claims the
group (train_status = 'running'), answers straight away, and run() does the work after
the response, recording the outcome on the group for the page to read.

A run is identified by its train_started_at. Every write after the claim is conditioned
on it, so a run that was declared stale and overtaken can never overwrite the newer
run's status.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime

from sqlalchemy import text

from app.data_access import phase1_store
from app.database import engine
from app.phase1 import train
from app.workers import prediction_jobs

log = logging.getLogger(__name__)

# A run still 'running' after this long is treated as dead (the service was restarted or
# the thread crashed hard): Train is offered again and a new claim may take over. Well
# above any real training time on this project's data. The backend uses the same value
# to tell the page (ML_TRAIN_STALE_MINUTES).
STALE_MINUTES = int(os.getenv("PHASE1_TRAIN_STALE_MINUTES", "60"))


def claim(conn, group_id: str) -> datetime | None:
    """
    Mark the group as training and return the run's start time, or None when it is
    already training (and that run is not stale). Atomic: two Train clicks cannot both
    start a run.
    """
    row = conn.execute(text("""
        UPDATE ml_groups
        SET    train_status = 'running', train_started_at = now(),
               train_finished_at = NULL, train_result = NULL, train_error = NULL
        WHERE  group_id = :gid
          AND  (train_status IS DISTINCT FROM 'running'
                OR train_started_at < now() - make_interval(mins => :stale))
        RETURNING train_started_at
    """), {"gid": group_id, "stale": STALE_MINUTES}).first()
    return row[0] if row else None


def _finish(group_id: str, started_at: datetime, status: str,
            result: dict | None = None, error: str | None = None) -> None:
    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE ml_groups
            SET    train_status = :status, train_finished_at = now(),
                   train_result = CAST(:result AS jsonb), train_error = :error
            WHERE  group_id = :gid AND train_started_at = :started
        """), {"gid": group_id, "started": started_at, "status": status,
               "result": json.dumps(result, default=str) if result is not None else None,
               "error": error})


def run(group_id: str, started_at: datetime, predict: bool = True) -> None:
    """
    Train the group's model, then (if asked) predict every member's completed sessions
    with it, and record the outcome. Never raises: any failure is recorded as 'failed'
    on the group, which is what the page shows.

    The run stays 'running' until predictions are written too, so "done" means the
    Insights tab already has the new model's predictions to show.
    """
    try:
        with engine.begin() as conn:
            summary = train.train_group_and_save(conn, group_id)
    except Exception as e:
        log.exception("Training group %s failed.", group_id)
        _finish(group_id, started_at, "failed", error=f"{type(e).__name__}: {e}")
        return

    result = {k: v for k, v in summary.items() if k != "artifact_path"}
    if summary.get("trained") and predict:
        try:
            with engine.connect() as conn:
                session_ids = phase1_store.group_session_ids(conn, group_id)
            if session_ids:
                result["inference"] = prediction_jobs.predict_sessions_with_model(
                    summary, session_ids)
        except Exception as e:
            # The model trained and is current; only the immediate predictions are
            # missing, and the background prediction worker still covers new sessions.
            log.exception("Predicting group %s's sessions failed.", group_id)
            result["inference"] = {"error": f"{type(e).__name__}: {e}"}

    _finish(group_id, started_at, "done", result=result)
