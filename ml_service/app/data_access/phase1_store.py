"""
data_access/phase1_store.py

Reads and writes for the ML Phase 1 model registry (ml_models) and per-session
predictions (session_predictions). Kept apart from queries.py, which is read-only
signal/label access — this module is where Phase 1 mutates the database.

All functions take an open connection and never commit; the caller owns the
transaction (matching the feature-worker convention).
"""

from __future__ import annotations

from sqlalchemy import text


# ── Model registry ────────────────────────────────────────────────────────────

def insert_model(conn, *, algo, artifact_path, n_epochs, n_distinct_images,
                 n_sessions, cv, null, make_current: bool) -> int:
    """
    Record a freshly trained model and return its model_version.

    `cv` and `null` are dicts keyed 'valence'/'arousal'; cv also carries 'mae'.
    If make_current, this becomes the model inference serves — done atomically with
    the insert so there is never a window with zero or two current models.
    """
    if make_current:
        conn.execute(text("UPDATE ml_models SET is_current = false WHERE is_current"))

    row = conn.execute(text("""
        INSERT INTO ml_models (
            algo, artifact_path, n_epochs, n_distinct_images, n_sessions,
            cv_r2_valence, cv_r2_arousal, cv_mae_valence, cv_mae_arousal,
            null_r2_valence, null_r2_arousal, is_current
        ) VALUES (
            :algo, :path, :n_epochs, :n_images, :n_sessions,
            :cv_r2_v, :cv_r2_a, :cv_mae_v, :cv_mae_a,
            :null_r2_v, :null_r2_a, :is_current
        )
        RETURNING model_version
    """), {
        "algo": algo, "path": artifact_path,
        "n_epochs": n_epochs, "n_images": n_distinct_images, "n_sessions": n_sessions,
        "cv_r2_v": cv["r2"]["valence"], "cv_r2_a": cv["r2"]["arousal"],
        "cv_mae_v": cv["mae"]["valence"], "cv_mae_a": cv["mae"]["arousal"],
        "null_r2_v": null["r2"]["valence"], "null_r2_a": null["r2"]["arousal"],
        "is_current": make_current,
    }).first()
    return int(row[0])


def current_model(conn) -> dict | None:
    """The model inference should serve, or None if nothing has been trained yet."""
    row = conn.execute(text("""
        SELECT * FROM ml_models WHERE is_current LIMIT 1
    """)).mappings().first()
    return dict(row) if row else None


def model_history(conn, limit: int = 20) -> list[dict]:
    """Every trained model, newest first — for the tab's model-version history."""
    rows = conn.execute(text("""
        SELECT * FROM ml_models ORDER BY model_version DESC LIMIT :limit
    """), {"limit": limit}).mappings().all()
    return [dict(r) for r in rows]


# ── Predictions ───────────────────────────────────────────────────────────────

def replace_session_predictions(conn, session_id: str, model_version: int,
                                 rows: list[dict]) -> int:
    """
    Idempotently write one session's predictions for a model. Deletes this
    (session, model) pair's existing rows first, so a recompute corrects rather
    than duplicates. Returns the number of rows written.
    """
    conn.execute(text("""
        DELETE FROM session_predictions
        WHERE session_id = :sid AND model_version = :ver
    """), {"sid": session_id, "ver": model_version})

    if not rows:
        return 0

    conn.execute(text("""
        INSERT INTO session_predictions (
            session_id, model_version, window_start, window_end,
            pred_valence, pred_arousal, actual_valence, actual_arousal, image_id
        ) VALUES (
            :session_id, :model_version, :window_start, :window_end,
            :pred_valence, :pred_arousal, :actual_valence, :actual_arousal, :image_id
        )
    """), rows)
    return len(rows)


def fetch_session_predictions(conn, session_id: str) -> list[dict]:
    """
    A session's predictions ordered in time, with each row's seconds-from-start so
    the frontend can plot without re-deriving the origin (mirrors the results
    endpoints' t_seconds convention).
    """
    rows = conn.execute(text("""
        SELECT p.window_start, p.window_end, p.pred_valence, p.pred_arousal,
               p.actual_valence, p.actual_arousal,
               p.image_id, p.model_version,
               EXTRACT(EPOCH FROM (p.window_start - s.start_time)) AS t_seconds
        FROM   session_predictions p
        JOIN   sessions s ON s.session_id = p.session_id
        WHERE  p.session_id = :sid
        ORDER  BY p.window_start ASC
    """), {"sid": session_id}).mappings().all()
    return [dict(r) for r in rows]


def sessions_with_predictions(conn) -> list[dict]:
    """
    Completed sessions and their prediction status, for the tab's session picker.
    """
    rows = conn.execute(text("""
        SELECT s.session_id, s.start_time, s.predictions_status,
               s.predictions_model_version,
               (SELECT count(*) FROM session_predictions p
                WHERE p.session_id = s.session_id) AS n_predictions
        FROM   sessions s
        WHERE  s.sync_status = 'completed'
        ORDER  BY s.start_time DESC
    """)).mappings().all()
    return [dict(r) for r in rows]
