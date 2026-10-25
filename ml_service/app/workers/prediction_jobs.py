"""
workers/prediction_jobs.py

Runs the current model of every group a session's client belongs to over that
session automatically, writing per-session valence/arousal predictions. This is the
INFERENCE half of Phase 1 — the thing that fires when a session finishes. Training
(producing the models this serves) is a separate, technician-started job per group;
see phase1/train.py.

It follows the exact shape of workers/feature_jobs.py — same 'completed' trigger,
same atomic claim, same status/stale machinery — for the same reasons documented
there. The one addition: if a session's client is in NO group with a trained model,
there is nothing to serve, so the worker leaves that session unclaimed
(predictions_status stays NULL) rather than marking it failed. It gets picked up on
the first tick after such a group model exists.
"""

from __future__ import annotations

import logging
import os

from sqlalchemy import text

from app.database import engine
from app.data_access import phase1_store, queries
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
    """
    Completed recordings with no automatic predictions yet whose client is in at least
    one group with a current model.

    The EXISTS is what keeps the queue moving: a session no model can serve would
    otherwise fill the batch on every tick and starve the ones that can be served.
    """
    rows = conn.execute(text("""
        SELECT s.session_id
        FROM   sessions s
        WHERE  s.sync_status = 'completed'
          AND  s.predictions_status IS NULL
          AND  EXISTS (SELECT 1 FROM ml_group_members gm
                       JOIN   ml_models m ON m.group_id = gm.group_id AND m.is_current
                       WHERE  gm.client_id = s.client_id)
        ORDER  BY s.start_time ASC
        LIMIT  :limit
    """), {"limit": limit}).mappings().all()
    return [str(r["session_id"]) for r in rows]


def process_session(session_id: str, cache: dict) -> bool:
    """
    Claim one session and predict it with the current model of every group its client
    is in. Returns True if this worker did the work (False = already claimed).

    sessions.predictions_model_version is single-valued; it records the newest model
    that ran. The prediction rows themselves (keyed by model_version) are the truth.
    """
    with engine.begin() as conn:
        if not _claim(conn, session_id):
            return False

    try:
        with engine.begin() as conn:
            client_id = queries.fetch_session_client(conn, session_id)
            models = phase1_store.current_models_for_client(conn, client_id) if client_id else []
            written = 0
            ran = []
            for model in models:
                bundle = _load_cached(model, cache)
                if bundle is None:
                    raise RuntimeError(f"model v{model['model_version']} artifact unreadable")
                version = int(model["model_version"])
                rows = inference.predict_session(conn, session_id, bundle, version)
                written += phase1_store.replace_session_predictions(conn, session_id, version, rows)
                ran.append(version)
            conn.execute(text("""
                UPDATE sessions
                SET    predictions_status        = 'ready',
                       predictions_computed_at   = now(),
                       predictions_model_version = :ver,
                       predictions_error         = NULL
                WHERE  session_id = :sid
            """), {"sid": session_id, "ver": max(ran) if ran else None})
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

    log.info("Predicted %s: %d windows from model(s) %s.", session_id, written, ran)
    return True


def _load_cached(model: dict, cache: dict) -> dict | None:
    """
    Load a model's artifact, reusing it across sessions in the same tick.

    Sessions in a batch usually resolve to the same models, and joblib.load pulls a
    fitted estimator off disk each time — caching by version keeps one tick to one
    read per distinct model instead of one per session.
    """
    version = int(model["model_version"])
    if version not in cache:
        try:
            cache[version] = inference.load_bundle(model["artifact_path"])
        except Exception:
            log.exception(
                "Cannot load model v%s artifact %s — is the MODEL_DIR volume "
                "mounted?", version, model.get("artifact_path"),
            )
            cache[version] = None
    return cache[version]


def tick() -> int:
    """
    One poll cycle. Does nothing until some group has a trained model.

    Each session is predicted by the current model of every group its client belongs
    to, so a client in a trained group gets predictions automatically on their next
    recording rather than waiting for someone to regenerate them by hand.
    """
    with engine.begin() as conn:
        reclaim_stale(conn)
        todo = pending_sessions(conn)

    cache: dict = {}
    done = 0
    for sid in todo:
        if process_session(sid, cache):
            done += 1
    return done


def predict_sessions_with_model(model: dict, session_ids: list[str]) -> dict:
    """
    Run one specific model over specific sessions, on demand.

    This is the technician-initiated path used straight after a group's model is
    trained, so its members' Insights tab has predictions without waiting for a
    background pass.

    ⚠ Deliberately does NOT touch sessions.predictions_status /
    predictions_model_version. Those columns describe the AUTOMATIC pass and are
    owned by tick(); writing them here would make a session that never had automatic
    predictions look already-processed, and the worker would skip it forever. The
    prediction rows themselves are the shared truth — session_predictions is keyed
    by (session_id, model_version, window_start), so these rows sit alongside the
    automatic ones rather than replacing them.
    """
    version = int(model["model_version"])
    try:
        bundle = inference.load_bundle(model["artifact_path"])
    except Exception as exc:
        log.exception("Cannot load model v%d for on-demand inference.", version)
        return {"model_version": version, "sessions": 0, "windows": 0,
                "error": f"{type(exc).__name__}: {exc}"}

    sessions_done = 0
    windows = 0
    failures: list[str] = []
    for sid in session_ids:
        try:
            with engine.begin() as conn:
                rows = inference.predict_session(conn, sid, bundle, version)
                windows += phase1_store.replace_session_predictions(
                    conn, sid, version, rows)
            sessions_done += 1
        except Exception as exc:
            # One bad session must not lose the rest of the batch.
            log.exception("On-demand inference failed for %s", sid)
            failures.append(f"{sid}: {type(exc).__name__}: {exc}")

    result = {"model_version": version, "sessions": sessions_done, "windows": windows}
    if failures:
        result["failures"] = failures
    log.info("On-demand inference with model v%d: %d session(s), %d window(s).",
             version, sessions_done, windows)
    return result


def requeue(conn, session_ids: list[str] | None = None) -> int:
    """
    Clear predictions_status so sessions are re-inferred on the next tick. With no
    arguments, requeues every completed session — the lever for recomputing all
    predictions against newly trained models. Safe because writes are idempotent
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

