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

def insert_model(conn, *, group_id: str, algo, artifact_path, n_epochs,
                 n_distinct_images, n_sessions, n_clients, cv, cv_no_bfi, null,
                 members: list[dict]) -> int:
    """
    Record a freshly trained group model, make it the group's current model, and
    return its model_version.

    `cv`, `cv_no_bfi` carry 'r2' and 'mae' dicts keyed 'valence'/'arousal'; `null`
    carries 'r2'. `members` is [{client_id, session_id}] — who contributed which
    session, kept in ml_model_sessions so the model's evidence survives later edits to
    the group.

    The demotion is scoped to the group and happens in the same transaction as the
    insert, so there is never a window with zero or two current models for a group
    (the partial unique index enforces it too).
    """
    conn.execute(text("""
        UPDATE ml_models SET is_current = false
        WHERE is_current AND group_id = :gid
    """), {"gid": group_id})

    row = conn.execute(text("""
        INSERT INTO ml_models (
            algo, artifact_path, n_epochs, n_distinct_images, n_sessions, n_clients,
            uses_bfi,
            cv_r2_valence, cv_r2_arousal, cv_mae_valence, cv_mae_arousal,
            cv_r2_valence_no_bfi, cv_r2_arousal_no_bfi,
            cv_mae_valence_no_bfi, cv_mae_arousal_no_bfi,
            null_r2_valence, null_r2_arousal, is_current, group_id
        ) VALUES (
            :algo, :path, :n_epochs, :n_images, :n_sessions, :n_clients,
            true,
            :cv_r2_v, :cv_r2_a, :cv_mae_v, :cv_mae_a,
            :nb_r2_v, :nb_r2_a, :nb_mae_v, :nb_mae_a,
            :null_r2_v, :null_r2_a, true, :gid
        )
        RETURNING model_version
    """), {
        "algo": algo, "path": artifact_path,
        "n_epochs": n_epochs, "n_images": n_distinct_images,
        "n_sessions": n_sessions, "n_clients": n_clients,
        "cv_r2_v": cv["r2"]["valence"], "cv_r2_a": cv["r2"]["arousal"],
        "cv_mae_v": cv["mae"]["valence"], "cv_mae_a": cv["mae"]["arousal"],
        "nb_r2_v": cv_no_bfi["r2"]["valence"], "nb_r2_a": cv_no_bfi["r2"]["arousal"],
        "nb_mae_v": cv_no_bfi["mae"]["valence"], "nb_mae_a": cv_no_bfi["mae"]["arousal"],
        "null_r2_v": null["r2"]["valence"], "null_r2_a": null["r2"]["arousal"],
        "gid": group_id,
    }).first()
    version = int(row[0])

    if members:
        conn.execute(text("""
            INSERT INTO ml_model_sessions (model_version, session_id, client_id)
            VALUES (:ver, :sid, :cid)
            ON CONFLICT DO NOTHING
        """), [{"ver": version, "sid": m["session_id"], "cid": m["client_id"]}
               for m in members])

    return version


def current_model(conn, group_id: str) -> dict | None:
    """The model serving a group, or None if it has not been trained yet."""
    row = conn.execute(text("""
        SELECT * FROM ml_models WHERE is_current AND group_id = :gid LIMIT 1
    """), {"gid": group_id}).mappings().first()
    return dict(row) if row else None


def current_models_for_client(conn, client_id: str) -> list[dict]:
    """
    The current model of every group the client belongs to, newest first. These are
    the models that predict that client's sessions.
    """
    rows = conn.execute(text("""
        SELECT m.model_version, m.artifact_path, m.group_id
        FROM   ml_group_members gm
        JOIN   ml_models m ON m.group_id = gm.group_id AND m.is_current
        WHERE  gm.client_id = :cid
        ORDER  BY m.model_version DESC
    """), {"cid": client_id}).mappings().all()
    return [dict(r) for r in rows]


def model_members(conn, model_version: int) -> list[dict]:
    """Who trained a model and with which session — the audit trail."""
    rows = conn.execute(text("""
        SELECT ms.client_id, c.name AS client_name, ms.session_id, s.start_time
        FROM   ml_model_sessions ms
        LEFT   JOIN clients c ON c.client_id = ms.client_id
        LEFT   JOIN sessions s ON s.session_id = ms.session_id
        WHERE  ms.model_version = :ver
        ORDER  BY c.name
    """), {"ver": model_version}).mappings().all()
    return [dict(r) for r in rows]


def group_session_ids(conn, group_id: str) -> list[str]:
    """Every completed session of every current member — what a new model predicts."""
    rows = conn.execute(text("""
        SELECT s.session_id
        FROM   ml_group_members gm
        JOIN   sessions s ON s.client_id = gm.client_id
        WHERE  gm.group_id = :gid AND s.sync_status = 'completed'
        ORDER  BY s.start_time
    """), {"gid": group_id}).mappings().all()
    return [str(r["session_id"]) for r in rows]


def model_artifacts(conn, group_id: str) -> list[dict]:
    """
    One group's model versions, artifact paths, and current flags, newest first —
    for the trainer's artifact-pruning housekeeping (see phase1/train.py).

    Always scoped to a group: a "keep the newest 5" across everyone would delete
    other groups' artifacts as soon as a handful of them had been trained, leaving
    live ml_models rows pointing at missing files.
    """
    rows = conn.execute(text("""
        SELECT model_version, artifact_path, is_current, group_id
        FROM   ml_models WHERE group_id = :gid
        ORDER  BY model_version DESC
    """), {"gid": group_id}).mappings().all()
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
    hold predictions from more than one version of its client's model, and those
    rows share the same window_start values — returning every version at once
    yields interleaved trajectories that plot as one impossible zig-zag.
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
    Which model versions actually hold predictions for this session, newest first.

    This is what drives the tab's model-version switch. It reads
    session_predictions rather than sessions.predictions_model_version because the
    rows ARE the truth: that column records only the automatic pass, while a
    technician-triggered train writes rows without touching it.
    """
    # Grouped on ml_models' primary key, so every other m.* column is functionally
    # dependent and needs no repeating in the GROUP BY.
    rows = conn.execute(text("""
        SELECT m.model_version,
               count(*) AS n_predictions,
               m.algo, m.group_id, g.name AS group_name, m.trained_at, m.is_current,
               m.n_distinct_images, m.n_clients, m.uses_bfi,
               m.cv_r2_valence, m.cv_r2_arousal,
               m.cv_r2_valence_no_bfi, m.cv_r2_arousal_no_bfi,
               m.null_r2_valence, m.null_r2_arousal
        FROM   session_predictions p
        JOIN   ml_models m ON m.model_version = p.model_version
        JOIN   ml_groups g ON g.group_id = m.group_id
        WHERE  p.session_id = :sid
        GROUP  BY m.model_version, g.name
        ORDER  BY m.model_version DESC
    """), {"sid": session_id}).mappings().all()
    return [dict(r) for r in rows]


def sessions_with_predictions(conn) -> list[dict]:
    """
    Completed sessions and their prediction status, for the tab's session picker.

    Carries client_id and client_name so the tab can say whose recording it is.
    n_group_models counts the current models of the groups the client belongs to —
    the models that predict this session.
    """
    rows = conn.execute(text("""
        SELECT s.session_id, s.start_time, s.predictions_status,
               s.predictions_model_version,
               s.client_id, c.name AS client_name,
               (SELECT count(*) FROM session_predictions p
                WHERE p.session_id = s.session_id) AS n_predictions,
               (SELECT count(*) FROM ml_group_members gm
                JOIN   ml_models m ON m.group_id = gm.group_id AND m.is_current
                WHERE  gm.client_id = s.client_id) AS n_group_models
        FROM   sessions s
        LEFT   JOIN clients c ON c.client_id = s.client_id
        WHERE  s.sync_status = 'completed'
        ORDER  BY s.start_time DESC
    """)).mappings().all()
    return [dict(r) for r in rows]


def group_models_summary(conn) -> list[dict]:
    """
    Every group's current model with its scores, for the group list (cross-clinic: the
    backend trims it to the caller's clinic). Groups with no model are absent.
    """
    rows = conn.execute(text("""
        SELECT m.group_id, m.model_version, m.algo, m.trained_at,
               m.n_clients, m.n_epochs, m.n_distinct_images, m.uses_bfi,
               m.cv_r2_valence, m.cv_r2_arousal, m.cv_mae_valence, m.cv_mae_arousal,
               m.cv_r2_valence_no_bfi, m.cv_r2_arousal_no_bfi,
               m.cv_mae_valence_no_bfi, m.cv_mae_arousal_no_bfi,
               m.null_r2_valence, m.null_r2_arousal
        FROM   ml_models m
        WHERE  m.is_current
    """)).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["members"] = model_members(conn, int(r["model_version"]))
        out.append(d)
    return out
