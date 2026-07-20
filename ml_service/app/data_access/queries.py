"""
data_access/queries.py

All SELECT queries the ML service runs against the database.

Tables read:
  - eeg_filtered_samples  : full-resolution 250 Hz SDK-FILTERED samples, already
                            in µV. Primary input for the elliptic filter path.
  - eeg_raw_samples       : full-resolution 250 Hz ADC samples (raw, unfiltered).
                            Legacy input for the Butterworth/notch + FFT path.
  - eeg_readings          : frame summaries — used only for quality gating (filt_pkpk)
  - sessions              : sample_rate, start_time, end_time, client_id
  - events                : stimulus shown_at / hidden_at, linked to EITHER an
                            image OR a question (mutually exclusive per
                            005_functions_and_updates.sql's chk_events_stimulus)
  - images                : category, valence_mean, arousal_mean (+ _sd) per image
  - questions             : prompt, correct_answer, difficulty per question

All functions accept an open SQLAlchemy connection so the caller controls
the transaction boundary. Returns plain list-of-dicts for easy downstream use.
"""

from sqlalchemy import text


# ── eeg_filtered_samples (SDK-filtered, primary input for elliptic path) ──────

def fetch_filtered_samples(conn, session_id: str) -> list[dict]:
    """
    Fetch all SDK-filtered samples for a session, ordered by time.

    Unlike eeg_raw_samples, these values are already in µV (SDK-filtered
    onboard the SenzeBand) — NO ADC conversion needed, and no Butterworth/
    notch filtering needed beforehand. This is the primary input for the
    elliptic filter path (feature_extraction/elliptic.py).

    Returns one dict per sample row:
      { time, fp1, fp2, t3, t4 }
    where fp1/fp2/t3/t4 are floats in µV.

    Args:
        conn:       SQLAlchemy connection.
        session_id: UUID string of the target session.
    """
    rows = conn.execute(text("""
        SELECT time, fp1, fp2, t3, t4
        FROM   eeg_filtered_samples
        WHERE  session_id = :session_id
        ORDER  BY time ASC
    """), {"session_id": session_id}).mappings().all()

    return [dict(r) for r in rows]


def fetch_filtered_samples_window(
    conn,
    session_id: str,
    start_time,
    end_time,
) -> list[dict]:
    """
    Fetch SDK-filtered samples within a specific time window (inclusive).
    Used by epoch alignment to slice filtered samples per stimulus event,
    and by the elliptic filter's sliding-window analysis.

    Args:
        conn:       SQLAlchemy connection.
        session_id: UUID string.
        start_time: datetime — window start (inclusive).
        end_time:   datetime — window end (inclusive).

    Returns:
        List of dicts { time, fp1, fp2, t3, t4 }, values already in µV.
    """
    rows = conn.execute(text("""
        SELECT time, fp1, fp2, t3, t4
        FROM   eeg_filtered_samples
        WHERE  session_id = :session_id
          AND  time BETWEEN :start_time AND :end_time
        ORDER  BY time ASC
    """), {
        "session_id": session_id,
        "start_time": start_time,
        "end_time":   end_time,
    }).mappings().all()

    return [dict(r) for r in rows]


# ── eeg_raw_samples (legacy — raw ADC counts, Butterworth/notch + FFT path) ───

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


# ── ML Phase 1 (labels + session selection) ───────────────────────────────────
# The EEG itself comes from fetch_filtered_samples above — the same rows the
# elliptic path reads. Deliberately one function, not two: a second copy of that
# query would be a second place for the channel mapping to drift.

def fetch_labelled_image_events(conn, session_id: str) -> list[dict]:
    """
    Fetch this session's IMAGE events joined to their OASIS labels.

    Returns one dict per event:
      { event_id, image_id, shown_at, hidden_at, filename, oasis_theme,
        valence_mean, valence_sd, arousal_mean, arousal_sd }

    Only events with a resolvable stimulus window (hidden_at IS NOT NULL) are
    returned — an event still open at session end has no bounded EEG window.
    Question events are excluded: the events table enforces image XOR question,
    so an INNER JOIN to images already drops them.
    """
    rows = conn.execute(text("""
        SELECT e.event_id,
               e.image_id,
               e.shown_at,
               e.hidden_at,
               i.filename,
               i.oasis_theme,
               i.valence_mean,
               i.valence_sd,
               i.arousal_mean,
               i.arousal_sd
        FROM   events e
        JOIN   images i ON i.image_id = e.image_id
        WHERE  e.session_id = :session_id
          AND  e.hidden_at IS NOT NULL
        ORDER  BY e.shown_at ASC
    """), {"session_id": session_id}).mappings().all()

    return [dict(r) for r in rows]


def fetch_completed_session_ids(conn) -> list[str]:
    """
    Every session whose EEG is fully written and therefore safe to train on.

    'completed' is set by the BRIDGE, after its stop-grace drain and final flush
    (BridgeController.FinalizeStop -> DbUploader.Dispose -> MarkCompletedInternal).
    It is the only signal that means "all my rows are in". Do not substitute an
    earlier one — the frontend finishing its stimulus sequence does not imply the
    bridge has finished writing.
    """
    rows = conn.execute(text("""
        SELECT session_id
        FROM   sessions
        WHERE  sync_status = 'completed'
        ORDER  BY start_time ASC
    """)).mappings().all()

    return [str(r["session_id"]) for r in rows]


def fetch_client_session_ids(conn, client_id: str) -> list[str]:
    """
    One client's completed sessions — the candidate training set for their personal
    model, and the list the technician picks from.

    Same 'completed' gate and the same reasoning as fetch_completed_session_ids:
    anything earlier risks training on a session the bridge is still flushing.
    """
    rows = conn.execute(text("""
        SELECT session_id
        FROM   sessions
        WHERE  sync_status = 'completed' AND client_id = :cid
        ORDER  BY start_time ASC
    """), {"cid": client_id}).mappings().all()

    return [str(r["session_id"]) for r in rows]


def fetch_session_client(conn, session_id: str) -> str | None:
    """
    Which client a session belongs to, so inference can resolve whose model to
    serve. NULL client_id is possible on old/unclaimed rows — the caller falls back
    to the population model in that case.
    """
    row = conn.execute(text("""
        SELECT client_id FROM sessions WHERE session_id = :sid
    """), {"sid": session_id}).mappings().first()
    return str(row["client_id"]) if row and row["client_id"] else None


# ── eeg_readings (quality gating only) ────────────────────────────────────────

def fetch_eeg_readings(conn, session_id: str) -> list[dict]:
    """
    Fetch frame-level summary rows for quality gating.
    Returns filt_pkpk values per channel — used by preprocessing/quality.py.

    Returns one dict per frame:
      { time, fp1_filt_pkpk, fp2_filt_pkpk, t3_filt_pkpk, t4_filt_pkpk,
        current_event_id }
    """
    rows = conn.execute(text("""
        SELECT time,
               fp1_filt_pkpk,
               fp2_filt_pkpk,
               t3_filt_pkpk,
               t4_filt_pkpk,
               current_event_id
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

    Per 005_functions_and_updates.sql, events.image_id is now nullable and
    mutually exclusive with the new events.question_id (chk_events_stimulus):
    each event is EITHER an image OR a question, never both. This uses LEFT
    JOINs (not INNER JOIN) on both images and questions, so question-based
    events are no longer silently dropped — image-only fields are NULL on a
    question event and vice versa.

    Returns one dict per event:
      { event_id, image_id, question_id, shown_at, hidden_at,
        filename, category, valence_mean, arousal_mean,
        question_no, prompt, correct_answer, difficulty }
    """
    rows = conn.execute(text("""
        SELECT e.event_id,
               e.image_id,
               e.question_id,
               e.shown_at,
               e.hidden_at,
               i.filename,
               i.category,
               i.valence_mean,
               i.arousal_mean,
               q.question_no,
               q.prompt,
               q.correct_answer,
               q.difficulty
        FROM   events e
        LEFT JOIN images    i ON i.image_id    = e.image_id
        LEFT JOIN questions q ON q.question_id = e.question_id
        WHERE  e.session_id = :session_id
        ORDER  BY e.shown_at ASC
    """), {"session_id": session_id}).mappings().all()

    return [dict(r) for r in rows]


# ── images ─────────────────────────────────────────────────────────────────────

def fetch_image(conn, image_id: str) -> dict | None:
    """
    Fetch metadata for a single image.

    Returns:
      { image_id, filename, category, valence_mean, arousal_mean }
    """
    row = conn.execute(text("""
        SELECT image_id, filename, category, valence_mean, arousal_mean
        FROM   images
        WHERE  image_id = :image_id
    """), {"image_id": image_id}).mappings().first()

    return dict(row) if row else None