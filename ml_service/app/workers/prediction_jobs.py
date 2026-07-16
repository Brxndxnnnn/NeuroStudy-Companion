"""
workers/prediction_jobs.py

Runs the current Phase 1 model over completed sessions automatically, writing per
session valence/arousal predictions. This is the INFERENCE half of Phase 1 — the
thing that fires when a session finishes. Training (producing the model this serves)
is a separate, occasional job; see phase1/train.py and the cron in app/main.py.

It follows the exact shape of workers/feature_jobs.py — same 'completed' trigger,
same atomic claim, same status/stale machinery — for the same reasons documented
there. The one addition: if NO model has been trained yet, there is nothing to
serve, so the worker does nothing and leaves sessions unclaimed (predictions_status
stays NULL) rather than marking them failed. They get picked up on the first tick
after a model is trained.
"""

from __future__ import annotations

import logging
import os

from sqlalchemy import text

from app.database import engine
from app.data_access import phase1_store
from app.phase1 import inference

log = logging.getLogger(__name__)

POLL_INTERVAL_S = int(os.getenv("PREDICTION_JOB_INTERVAL_S", "15"))
STALE_MINUTES = int(os.getenv("PREDICTION_JOB_STALE_MINUTES", "15"))
BATCH = int(os.getenv("PREDICTION_JOB_BATCH", "5"))


def _claim(conn, session_id: str) -> bool:
    """Take ownership of a session for inference. Exactly one worker can win."""
    row = conn.execute(text("""
        UPDATE sessions
        SET    predictions_status     = 'running',
               predictions_started_at = now(),
               predictions_error      = NULL
        WHERE  session_id = :sid
          AND  predictions_status IS DISTINCT FROM 'running'
        RETURNING session_id
    """), {"sid": session_id}).first()
    return row is not None


def reclaim_stale(conn) -> int:
    """Requeue sessions whose worker died mid-inference."""
    result = conn.execute(text(f"""
        UPDATE sessions
        SET    predictions_status = NULL,
               predictions_error  = 'Worker died mid-inference; requeued.'
        WHERE  predictions_status = 'running'
          AND  predictions_started_at < now() - interval '{STALE_MINUTES} minutes'
        RETURNING session_id
    """))
    ids = [r[0] for r in result]
    if ids:
        log.warning("Requeued %d stale prediction job(s): %s", len(ids), ids)
    return len(ids)


def pending_sessions(conn, limit: int = BATCH) -> list[str]:
    """Completed recordings that have no predictions yet."""
    rows = conn.execute(text("""
        SELECT session_id
        FROM   sessions
        WHERE  sync_status = 'completed'
          AND  predictions_status IS NULL
        ORDER  BY start_time ASC
        LIMIT  :limit
    """), {"limit": limit}).all()
    return [str(r[0]) for r in rows]


def process_session(session_id: str, model: dict, bundle: dict) -> bool:
    """
    Claim one session, run inference, and record the outcome. Returns True if this
    worker did the work (False = already claimed by someone else).
    """
    with engine.begin() as conn:
        if not _claim(conn, session_id):
            return False

    version = int(model["model_version"])
    try:
        with engine.begin() as conn:
            rows = inference.predict_session(conn, session_id, bundle, version)
            written = phase1_store.replace_session_predictions(
                conn, session_id, version, rows)
            conn.execute(text("""
                UPDATE sessions
                SET    predictions_status        = 'ready',
                       predictions_computed_at   = now(),
                       predictions_model_version = :ver,
                       predictions_error         = NULL
                WHERE  session_id = :sid
            """), {"sid": session_id, "ver": version})
    except Exception as exc:
        log.exception("Inference failed for %s", session_id)
        with engine.begin() as conn:
            conn.execute(text("""
                UPDATE sessions
                SET    predictions_status = 'failed',
                       predictions_error  = :err
                WHERE  session_id = :sid
            """), {"sid": session_id, "err": f"{type(exc).__name__}: {exc}"[:1000]})
        return True

    log.info("Predicted %s: %d windows (model v%d).", session_id, written, version)
    return True


def tick() -> int:
    """One poll cycle. Does nothing until a model has been trained."""
    with engine.begin() as conn:
        model = phase1_store.current_model(conn)
    if model is None:
        return 0  # no model yet — leave sessions unclaimed for a later tick

    try:
        bundle = inference.load_bundle(model["artifact_path"])
    except Exception:
        log.exception("Cannot load current model artifact %s — is the MODEL_DIR "
                      "volume mounted?", model.get("artifact_path"))
        return 0

    with engine.begin() as conn:
        reclaim_stale(conn)
        todo = pending_sessions(conn)

    return sum(1 for sid in todo if process_session(sid, model, bundle))


def requeue(conn, session_ids: list[str] | None = None) -> int:
    """
    Clear predictions_status so sessions are re-inferred on the next tick. With no
    arguments, requeues every completed session — the lever for recomputing all
    predictions against a newly promoted model. Safe because writes are idempotent
    (replace_session_predictions deletes the (session, model) rows first).
    """
    if session_ids:
        result = conn.execute(text("""
            UPDATE sessions SET predictions_status = NULL, predictions_error = NULL
            WHERE session_id = ANY(:ids) AND sync_status = 'completed'
            RETURNING session_id
        """), {"ids": session_ids})
    else:
        result = conn.execute(text("""
            UPDATE sessions SET predictions_status = NULL, predictions_error = NULL
            WHERE sync_status = 'completed'
            RETURNING session_id
        """))
    return len(result.all())
