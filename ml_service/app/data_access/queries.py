"""
data_access/queries.py

All SELECT queries the ML service runs against the database.

Tables read:
  - eeg_raw_samples  : full-resolution 250 Hz ADC samples (primary ML input)
  - eeg_readings     : frame summaries — used only for quality gating (filt_pkpk)
  - sessions         : sample_rate, start_time, end_time, client_id
  - events           : stimulus shown_at / hidden_at per image
  - images           : category, valence_score, arousal_score per image

All functions accept an open SQLAlchemy connection so the caller controls
the transaction boundary. Returns plain list-of-dicts for easy downstream use.
"""

from sqlalchemy import text


# ── eeg_raw_samples ────────────────────────────────────────────────────────────

def fetch_raw_samples(conn, session_id: str) -> list[dict]:
    """
    Fetch all raw ADC samples for a session, ordered by time.

    Returns one dict per sample row:
      { time, fp1, fp2, t3, t4 }
    where fp1/fp2/t3/t4 are raw integer ADC counts.
    Convert to µV: value * 0.02235

    Args:
        conn:       SQLAlchemy connection.
        session_id: UUID string of the target session.
    """
    rows = conn.execute(text("""
        SELECT time, fp1, fp2, t3, t4
        FROM   eeg_raw_samples
        WHERE  session_id = :session_id
        ORDER  BY time ASC
    """), {"session_id": session_id}).mappings().all()

    return [dict(r) for r in rows]


def fetch_raw_samples_window(
    conn,
    session_id: str,
    start_time,
    end_time,
) -> list[dict]:
    """
    Fetch raw samples within a specific time window (inclusive).
    Used by epoch alignment to slice samples per stimulus event.

    Args:
        conn:       SQLAlchemy connection.
        session_id: UUID string.
        start_time: datetime — window start (inclusive).
        end_time:   datetime — window end (inclusive).
    """
    rows = conn.execute(text("""
        SELECT time, fp1, fp2, t3, t4
        FROM   eeg_raw_samples
        WHERE  session_id = :session_id
          AND  time BETWEEN :start_time AND :end_time
        ORDER  BY time ASC
    """), {
        "session_id": session_id,
        "start_time": start_time,
        "end_time":   end_time,
    }).mappings().all()

    return [dict(r) for r in rows]


# ── eeg_readings (quality gating only) ────────────────────────────────────────

def fetch_eeg_readings(conn, session_id: str) -> list[dict]:
    """
    Fetch frame-level summary rows for quality gating.
    Returns filt_pkpk values per channel — used by preprocessing/quality.py.

    Returns one dict per frame:
      { time, fp1_filt_pkpk, fp2_filt_pkpk, t3_filt_pkpk, t4_filt_pkpk,
        current_image_id }
    """
    rows = conn.execute(text("""
        SELECT time,
               fp1_filt_pkpk,
               fp2_filt_pkpk,
               t3_filt_pkpk,
               t4_filt_pkpk,
               current_image_id
        FROM   eeg_readings
        WHERE  session_id = :session_id
        ORDER  BY time ASC
    """), {"session_id": session_id}).mappings().all()

    return [dict(r) for r in rows]


# ── sessions ───────────────────────────────────────────────────────────────────

def fetch_session(conn, session_id: str) -> dict | None:
    """
    Fetch session metadata for a single session.

    Returns:
      { session_id, client_id, clinic_id, start_time, end_time,
        sample_rate, device_id }
    or None if not found.
    """
    row = conn.execute(text("""
        SELECT session_id,
               client_id,
               clinic_id,
               start_time,
               end_time,
               sample_rate,
               device_id
        FROM   sessions
        WHERE  session_id = :session_id
    """), {"session_id": session_id}).mappings().first()

    return dict(row) if row else None


def fetch_sessions_for_client(conn, client_id: str) -> list[dict]:
    """
    Fetch all completed sessions for a client, ordered oldest-first.
    Used by trend/decay analysis to build per-client history.
    """
    rows = conn.execute(text("""
        SELECT session_id,
               client_id,
               clinic_id,
               start_time,
               end_time,
               sample_rate
        FROM   sessions
        WHERE  client_id   = :client_id
          AND  sync_status = 'synced'
          AND  end_time    IS NOT NULL
        ORDER  BY start_time ASC
    """), {"client_id": client_id}).mappings().all()

    return [dict(r) for r in rows]


# ── events ─────────────────────────────────────────────────────────────────────

def fetch_events(conn, session_id: str) -> list[dict]:
    """
    Fetch all stimulus events for a session, ordered by shown_at.
    Used by epoch alignment to slice EEG into stimulus windows.

    Returns one dict per event:
      { event_id, image_id, shown_at, hidden_at,
        filename, category, valence_score, arousal_score }
    """
    rows = conn.execute(text("""
        SELECT e.event_id,
               e.image_id,
               e.shown_at,
               e.hidden_at,
               i.filename,
               i.category,
               i.valence_score,
               i.arousal_score
        FROM   events e
        JOIN   images i ON i.image_id = e.image_id
        WHERE  e.session_id = :session_id
        ORDER  BY e.shown_at ASC
    """), {"session_id": session_id}).mappings().all()

    return [dict(r) for r in rows]


# ── images ─────────────────────────────────────────────────────────────────────

def fetch_image(conn, image_id: str) -> dict | None:
    """
    Fetch metadata for a single image.

    Returns:
      { image_id, filename, category, valence_score, arousal_score }
    """
    row = conn.execute(text("""
        SELECT image_id, filename, category, valence_score, arousal_score
        FROM   images
        WHERE  image_id = :image_id
    """), {"image_id": image_id}).mappings().first()

    return dict(row) if row else None