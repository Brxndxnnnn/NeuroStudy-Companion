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
                 n_sessions, cv, null, make_current: bool,
                 client_id: str | None = None,
                 session_ids: list[str] | None = None) -> int:
    """
    Record a freshly trained model and return its model_version.

    `cv` and `null` are dicts keyed 'valence'/'arousal'; cv also carries 'mae'.

    client_id=None registers a POPULATION model (the weekly cron); a client_id
    registers that client's PERSONAL model. If make_current, this becomes the model
    inference serves for its own scope — the demotion below is scoped identically,
    so promoting a personal model never disturbs the population model or any other
    client's, and it happens in the same statement pair as the insert so there is
    never a window with zero or two current models in a scope.

    session_ids records which sessions the fit actually used. Always pass it for a
    technician-triggered train: it is the audit trail that makes a hand-picked
    training set defensible rather than merely convenient.
    """
    if make_current:
        if client_id is None:
            conn.execute(text("""
                UPDATE ml_models SET is_current = false
                WHERE is_current AND client_id IS NULL
            """))
        else:
            conn.execute(text("""
                UPDATE ml_models SET is_current = false
                WHERE is_current AND client_id = :cid
            """), {"cid": client_id})

    row = conn.execute(text("""
        INSERT INTO ml_models (
            algo, artifact_path, n_epochs, n_distinct_images, n_sessions,
            cv_r2_valence, cv_r2_arousal, cv_mae_valence, cv_mae_arousal,
            null_r2_valence, null_r2_arousal, is_current, client_id
        ) VALUES (
            :algo, :path, :n_epochs, :n_images, :n_sessions,
            :cv_r2_v, :cv_r2_a, :cv_mae_v, :cv_mae_a,
            :null_r2_v, :null_r2_a, :is_current, :client_id
        )
        RETURNING model_version
    """), {
        "algo": algo, "path": artifact_path,
        "n_epochs": n_epochs, "n_images": n_distinct_images, "n_sessions": n_sessions,
        "cv_r2_v": cv["r2"]["valence"], "cv_r2_a": cv["r2"]["arousal"],
        "cv_mae_v": cv["mae"]["valence"], "cv_mae_a": cv["mae"]["arousal"],
        "null_r2_v": null["r2"]["valence"], "null_r2_a": null["r2"]["arousal"],
        "is_current": make_current, "client_id": client_id,
    }).first()
    version = int(row[0])

    if session_ids:
        conn.execute(text("""
            INSERT INTO ml_model_sessions (model_version, session_id)
            VALUES (:ver, :sid)
            ON CONFLICT DO NOTHING
        """), [{"ver": version, "sid": s} for s in session_ids])

    return version


def current_model(conn, client_id: str | None = None) -> dict | None:
    """
    The population model inference falls back to, or None if none is trained.

    Takes client_id only so callers that already have one can be explicit; pass a
    client and you get that client's model WITHOUT the fallback. For the normal
    "serve the best available model for this session" question, use
    current_model_for(), which is the one that implements the fallback rule.
    """
    if client_id is None:
        row = conn.execute(text("""
            SELECT * FROM ml_models WHERE is_current AND client_id IS NULL LIMIT 1
        """)).mappings().first()
    else:
        row = conn.execute(text("""
            SELECT * FROM ml_models WHERE is_current AND client_id = :cid LIMIT 1
        """), {"cid": client_id}).mappings().first()
    return dict(row) if row else None


def current_model_for(conn, client_id: str | None) -> dict | None:
    """
    The model to serve for one client: their personal model if they have one,
    otherwise the population model. Returns None only when neither exists.

    This is the decided rule — a personal model always wins once it exists, because
    a model fitted to this person's own EEG is the entire point of training one.
    The population model is what covers a client on their first session, before
    there is anything personal to serve.
    """
    if client_id is not None:
        personal = current_model(conn, client_id)
        if personal:
            return personal
    return current_model(conn, None)


def model_history(conn, limit: int = 20, client_id: str | None = None) -> list[dict]:
    """
    Trained models, newest first — for the tab's model-version history.

    client_id=None returns every model (population and personal alike), which is
    what an operator-level history wants. Pass a client to see only theirs.
    """
    if client_id is None:
        rows = conn.execute(text("""
            SELECT * FROM ml_models ORDER BY model_version DESC LIMIT :limit
        """), {"limit": limit}).mappings().all()
    else:
        rows = conn.execute(text("""
            SELECT * FROM ml_models WHERE client_id = :cid
            ORDER BY model_version DESC LIMIT :limit
        """), {"limit": limit, "cid": client_id}).mappings().all()
    return [dict(r) for r in rows]


def model_sessions(conn, model_version: int) -> list[str]:
    """Which sessions trained a given model — the audit trail from migration 012."""
    rows = conn.execute(text("""
        SELECT session_id FROM ml_model_sessions WHERE model_version = :ver
    """), {"ver": model_version}).mappings().all()
    return [str(r["session_id"]) for r in rows]


def model_artifacts(conn, client_id: str | None = None,
                    scoped: bool = False) -> list[dict]:
    """
    Model version, artifact path, and current flag, newest first — for the trainer's
    artifact-pruning housekeeping (see phase1/train.py).

    scoped=True restricts to one scope (a client's own models, or the population
    models when client_id is None). Pruning MUST be scoped: a global "keep the
    newest 5" would delete every client's artifacts as soon as a handful of other
    clients had been trained, leaving live ml_models rows pointing at missing files.
    """
    if not scoped:
        rows = conn.execute(text("""
            SELECT model_version, artifact_path, is_current, client_id
            FROM   ml_models
            ORDER  BY model_version DESC
        """)).mappings().all()
    elif client_id is None:
        rows = conn.execute(text("""
            SELECT model_version, artifact_path, is_current, client_id
            FROM   ml_models WHERE client_id IS NULL
            ORDER  BY model_version DESC
        """)).mappings().all()
    else:
        rows = conn.execute(text("""
            SELECT model_version, artifact_path, is_current, client_id
            FROM   ml_models WHERE client_id = :cid
            ORDER  BY model_version DESC
        """), {"cid": client_id}).mappings().all()
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


def fetch_session_predictions(conn, session_id: str,
                              model_version: int | None = None) -> list[dict]:
    """
    A session's predictions ordered in time, with each row's seconds-from-start so
    the frontend can plot without re-deriving the origin (mirrors the results
    endpoints' t_seconds convention).

    ⚠ ALWAYS pass model_version when the rows are going to be charted. A session can
    now hold predictions from BOTH the population model and its client's personal
    model, and those rows share the same window_start values — returning every model
    at once yields two interleaved trajectories that plot as one impossible zig-zag.
    Omitting it (every model's rows) is for callers that genuinely want the lot.
    """
    if model_version is None:
        rows = conn.execute(text("""
            SELECT p.window_start, p.window_end, p.pred_valence, p.pred_arousal,
                   p.actual_valence, p.actual_arousal,
                   p.image_id, p.model_version,
                   EXTRACT(EPOCH FROM (p.window_start - s.start_time)) AS t_seconds
            FROM   session_predictions p
            JOIN   sessions s ON s.session_id = p.session_id
            WHERE  p.session_id = :sid
            ORDER  BY p.model_version, p.window_start ASC
        """), {"sid": session_id}).mappings().all()
    else:
        rows = conn.execute(text("""
            SELECT p.window_start, p.window_end, p.pred_valence, p.pred_arousal,
                   p.actual_valence, p.actual_arousal,
                   p.image_id, p.model_version,
                   EXTRACT(EPOCH FROM (p.window_start - s.start_time)) AS t_seconds
            FROM   session_predictions p
            JOIN   sessions s ON s.session_id = p.session_id
            WHERE  p.session_id = :sid AND p.model_version = :ver
            ORDER  BY p.window_start ASC
        """), {"sid": session_id, "ver": model_version}).mappings().all()
    return [dict(r) for r in rows]


def session_prediction_models(conn, session_id: str) -> list[dict]:
    """
    Which models actually hold predictions for this session, personal first.

    This is what drives the tab's global-vs-personal switch. It reads
    session_predictions rather than sessions.predictions_model_version because the
    rows ARE the truth: that column records only the automatic pass, while a
    technician-generated personal model writes rows without touching it.
    """
    # Grouped on ml_models' primary key, so every other m.* column is functionally
    # dependent and needs no repeating in the GROUP BY.
    rows = conn.execute(text("""
        SELECT m.model_version,
               count(*) AS n_predictions,
               m.algo, m.client_id, m.trained_at, m.is_current,
               m.n_distinct_images,
               m.cv_r2_valence, m.cv_r2_arousal,
               m.null_r2_valence, m.null_r2_arousal
        FROM   session_predictions p
        JOIN   ml_models m ON m.model_version = p.model_version
        WHERE  p.session_id = :sid
        GROUP  BY m.model_version
        ORDER  BY (m.client_id IS NULL), m.model_version DESC
    """), {"sid": session_id}).mappings().all()
    return [dict(r) for r in rows]


def sessions_with_predictions(conn) -> list[dict]:
    """
    Completed sessions and their prediction status, for the tab's session picker.

    Carries client_id and client_name so the tab can say whose recording it is and
    offer to train that person's model without a second round trip. has_personal_model
    lets it show, per session, whether a personal model already exists to serve it.
    """
    rows = conn.execute(text("""
        SELECT s.session_id, s.start_time, s.predictions_status,
               s.predictions_model_version,
               s.client_id, c.name AS client_name,
               (SELECT count(*) FROM session_predictions p
                WHERE p.session_id = s.session_id) AS n_predictions,
               EXISTS (SELECT 1 FROM ml_models m
                       WHERE m.client_id = s.client_id AND m.is_current)
                   AS has_personal_model
        FROM   sessions s
        LEFT   JOIN clients c ON c.client_id = s.client_id
        WHERE  s.sync_status = 'completed'
        ORDER  BY s.start_time DESC
    """)).mappings().all()
    return [dict(r) for r in rows]
