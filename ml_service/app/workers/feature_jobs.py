"""
workers/feature_jobs.py

Computes a session's window features automatically, once the recording is safely
on disk. Runs inside the ML service process — there is no script to remember to
start.

THE TRIGGER: sessions.sync_status = 'completed'. NOTHING EARLIER.
------------------------------------------------------------------
The bridge's stop path is:

    StopSession()
      -> 4-second stop-grace drain      (catches BLE frames still in flight)
      -> FinalizeStop()
         -> DbUploader.Dispose()
            -> final Flush()            <-- the last EEG rows land HERE
         -> MarkCompletedInternal()     <-- only NOW is sync_status = 'completed'

So when the frontend finishes its stimulus sequence, the bridge may still be
draining and flushing. A job triggered there would compute on a TRUNCATED TAIL of
the recording — silently, with no error, every session slightly short at the end.
'completed' is the bridge's own "all my rows are in" signal, and it is the only
safe one.

WHY POLL RATHER THAN BE CALLED
------------------------------
Nothing has to notify us. The ML service already holds DB credentials, which is how
the bridge works too (write direct, no gateway). Polling needs no cooperation from
the backend, survives a restart, and picks up sessions that completed while this
process was down — none of which is true of a fire-and-forget HTTP call.

WHY THE CLAIM IS ATOMIC
-----------------------
uvicorn may run several workers, and dev mode runs a reloader, so more than one
scheduler can be alive at once. The UPDATE ... WHERE features_status IS DISTINCT
FROM 'running' RETURNING is what makes that safe: exactly one caller gets the row
back, everyone else gets nothing and moves on. Without it, two workers would
compute the same session and double-insert.

WHY THE STATUS COLUMNS EXIST
----------------------------
Zero rows in a feature table reads identically as "not started", "still running",
"finished with nothing" and "the worker crashed". Only the thing that ran the job
knows which, so the worker writes what happened and the results page reads it back.
Without this, a crashed worker is indistinguishable from a slow one — forever.
"""

from __future__ import annotations

import logging
import os
from importlib import import_module

from sqlalchemy import text

from app.database import engine

log = logging.getLogger(__name__)

# The actual feature computation is not this module's job. It is imported from a
# dotted "module:function" path so the maths can live wherever its author wants it,
# and so this harness has no opinion about it.
#
# CONTRACT — the function is called as:
#
#     compute_session_features(conn, session_id: str) -> int
#
#   * `conn` is an open SQLAlchemy connection inside a transaction that this module
#     commits (on return) or rolls back (on exception). Do not commit it yourself.
#   * Return the number of rows written. Returning 0 is allowed and is recorded as
#     'ready' — a session with no usable EEG is a real outcome, not a failure.
#   * MUST BE IDEMPOTENT. A session can be recomputed (a backfill, a changed window
#     size, a reclaimed stale job), so delete this session's existing feature rows
#     before inserting. Otherwise a re-run silently doubles them.
#   * Raise on failure. The exception message is stored in sessions.features_error
#     and shown to whoever opens the results page, so make it worth reading.
COMPUTE_FN_PATH = os.getenv(
    "FEATURE_COMPUTE_FN", "app.features.elliptic:compute_session_features"
)

POLL_INTERVAL_S = int(os.getenv("FEATURE_JOB_INTERVAL_S", "10"))
# How long a claim may sit in 'running' before it is assumed dead. A worker killed
# mid-job would otherwise wedge that session in 'running' and it would never be
# retried by anyone.
STALE_MINUTES = int(os.getenv("FEATURE_JOB_STALE_MINUTES", "15"))
BATCH = int(os.getenv("FEATURE_JOB_BATCH", "5"))


def load_compute_fn():
    """
    Resolve COMPUTE_FN_PATH. Returns None (with a loud log line) if it isn't there —
    the scheduler then simply doesn't start, rather than claiming every completed
    session and marking it 'failed'.
    """
    try:
        module_path, _, fn_name = COMPUTE_FN_PATH.partition(":")
        if not fn_name:
            raise ValueError(
                f"FEATURE_COMPUTE_FN must be 'module:function', got {COMPUTE_FN_PATH!r}"
            )
        fn = getattr(import_module(module_path), fn_name)
    except Exception as exc:
        log.warning(
            "Feature job DISABLED: cannot import %s (%s). "
            "Create that module with compute_session_features(conn, session_id) -> int, "
            "or point FEATURE_COMPUTE_FN somewhere else.",
            COMPUTE_FN_PATH, exc,
        )
        return None
    return fn


def _claim(conn, session_id: str) -> bool:
    """
    Take ownership of a session. Exactly one caller can win this, however many
    workers race for it — which is the whole point.
    """
    row = conn.execute(text("""
        UPDATE sessions
        SET    features_status     = 'running',
               features_started_at = now(),
               features_error      = NULL
        WHERE  session_id = :sid
          AND  features_status IS DISTINCT FROM 'running'
        RETURNING session_id
    """), {"sid": session_id}).first()
    return row is not None


def reclaim_stale(conn) -> int:
    """Free sessions whose worker died mid-job, so they get retried."""
    result = conn.execute(text(f"""
        UPDATE sessions
        SET    features_status = NULL,
               features_error  = 'Worker died mid-computation; requeued.'
        WHERE  features_status = 'running'
          AND  features_started_at < now() - interval '{STALE_MINUTES} minutes'
        RETURNING session_id
    """))
    ids = [r[0] for r in result]
    if ids:
        log.warning("Requeued %d stale feature job(s): %s", len(ids), ids)
    return len(ids)


def pending_sessions(conn, limit: int = BATCH) -> list[str]:
    """
    Completed recordings that still need features.

    'completed' is written by the BRIDGE after its final flush — see the module
    docstring. Do not relax this to an earlier state.
    """
    rows = conn.execute(text("""
        SELECT session_id
        FROM   sessions
        WHERE  sync_status = 'completed'
          AND  features_status IS NULL
        ORDER  BY start_time ASC
        LIMIT  :limit
    """), {"limit": limit}).all()
    return [str(r[0]) for r in rows]


def process_session(compute_fn, session_id: str) -> bool:
    """
    Claim, compute, and record the outcome for one session. Returns True if this
    worker did the work (False = someone else had already claimed it).

    Each session gets its own transaction, so one bad session cannot roll back the
    others in the same tick.
    """
    with engine.begin() as conn:
        if not _claim(conn, session_id):
            return False

    try:
        with engine.begin() as conn:
            written = compute_fn(conn, session_id)
    except Exception as exc:
        log.exception("Feature computation failed for %s", session_id)
        # A separate transaction: the failing one was rolled back, including any
        # partial feature rows, so the error has to be written on a fresh one.
        with engine.begin() as conn:
            conn.execute(text("""
                UPDATE sessions
                SET    features_status = 'failed',
                       features_error  = :err
                WHERE  session_id = :sid
            """), {"sid": session_id, "err": f"{type(exc).__name__}: {exc}"[:1000]})
        return True

    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE sessions
            SET    features_status      = 'ready',
                   features_computed_at = now(),
                   features_error       = NULL
            WHERE  session_id = :sid
        """), {"sid": session_id})

    log.info("Computed features for %s (%s rows).", session_id, written)
    return True


def tick(compute_fn=None) -> int:
    """One poll cycle. Returns how many sessions this worker processed."""
    compute_fn = compute_fn or load_compute_fn()
    if compute_fn is None:
        return 0

    with engine.begin() as conn:
        reclaim_stale(conn)
        todo = pending_sessions(conn)

    return sum(1 for sid in todo if process_session(compute_fn, sid))


def requeue(conn, session_ids: list[str] | None = None) -> int:
    """
    Clear features_status so sessions are picked up again on the next tick.

    This is the backfill lever: with no arguments it requeues every completed
    session, including ones already computed. Safe precisely because the compute
    function is required to be idempotent — it deletes its own rows before writing.
    """
    if session_ids:
        result = conn.execute(text("""
            UPDATE sessions SET features_status = NULL, features_error = NULL
            WHERE session_id = ANY(:ids) AND sync_status = 'completed'
            RETURNING session_id
        """), {"ids": session_ids})
    else:
        result = conn.execute(text("""
            UPDATE sessions SET features_status = NULL, features_error = NULL
            WHERE sync_status = 'completed'
            RETURNING session_id
        """))
    return len(result.all())
