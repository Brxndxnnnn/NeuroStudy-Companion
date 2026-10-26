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

import os

import numpy as np
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


# Minimum sessions.timeline_version accepted for training.
#
#   1 = the pre-fix bridge, whose drift guard absorbed sub-3-second losses and
#       COMPRESSED the sample timeline. Its EEG is real but its event alignment is up
#       to 3 s out, so a share of every image's epochs carries the neighbouring
#       stimulus's signal under the wrong label (migration 014).
#   2 = sub-second drift tolerance: gaps are real, alignment is trustworthy.
#
# Defaults to 1 — INCLUDE EVERYTHING — deliberately. Every session recorded before the
# fix is version 1, so defaulting to 2 would drop the training set to zero the moment
# this deploys and quietly leave every client with nothing to train on. Raise it to 2
# via PHASE1_MIN_TIMELINE_VERSION once enough post-fix sessions have accumulated; the
# mix is logged on every train so the decision is informed rather than guessed.
MIN_TIMELINE_VERSION = int(os.getenv("PHASE1_MIN_TIMELINE_VERSION", "1"))


def fetch_completed_session_ids(conn) -> list[str]:
    """
    Every session whose EEG is fully written and therefore safe to train on.

    'completed' is set by the BRIDGE, after its stop-grace drain and final flush
    (BridgeController.FinalizeStop -> DbUploader.Dispose -> MarkCompletedInternal).
    It is the only signal that means "all my rows are in". Do not substitute an
    earlier one — the frontend finishing its stimulus sequence does not imply the
    bridge has finished writing.

    Also gated on timeline_version — see MIN_TIMELINE_VERSION.
    """
    rows = conn.execute(text("""
        SELECT session_id
        FROM   sessions
        WHERE  sync_status = 'completed'
          AND  COALESCE(timeline_version, 1) >= :minver
        ORDER  BY start_time ASC
    """), {"minver": MIN_TIMELINE_VERSION}).mappings().all()

    return [str(r["session_id"]) for r in rows]


# ── Group models (migration 025) ──────────────────────────────────────────────

# BFI-2 domains in the order a model's extra input columns use them.
BFI_DOMAINS = ("E", "A", "C", "N", "O")


def fetch_group_members(conn, group_id: str) -> list[dict]:
    """A group's members: [{client_id, client_name}], oldest member first."""
    rows = conn.execute(text("""
        SELECT m.client_id, c.name AS client_name
        FROM   ml_group_members m
        JOIN   clients c ON c.client_id = m.client_id
        WHERE  m.group_id = :gid
        ORDER  BY m.added_at ASC, c.name ASC
    """), {"gid": group_id}).mappings().all()
    return [{"client_id": str(r["client_id"]), "client_name": r["client_name"]} for r in rows]


def fetch_group(conn, group_id: str) -> dict | None:
    row = conn.execute(text("""
        SELECT group_id, clinic_id, name FROM ml_groups WHERE group_id = :gid
    """), {"gid": group_id}).mappings().first()
    return dict(row) if row else None


def fetch_client(conn, client_id: str) -> dict | None:
    """{client_id, client_name, clinic_id} for one client, or None."""
    row = conn.execute(text("""
        SELECT client_id, name AS client_name, clinic_id
        FROM   clients WHERE client_id = CAST(:cid AS uuid)
    """), {"cid": client_id}).mappings().first()
    return ({"client_id": str(row["client_id"]), "client_name": row["client_name"],
             "clinic_id": str(row["clinic_id"])} if row else None)


# Channels and bands of fft_band_powers (migration 009), in column order.
FFT_CHANNELS = ("fp1", "fp2", "t3", "t4")
FFT_BANDS = ("delta", "theta", "alpha", "beta", "gamma")


def fetch_session_band_powers(conn, session_id: str):
    """
    One session's FFT band powers (our own Welch PSD, written by the feature worker) as
    an array of shape (windows, channels, bands) in FFT_CHANNELS x FFT_BANDS order, µV².
    Empty (0 windows) when the worker has not processed the session.
    """
    cols = ", ".join(f"{c}_{b}" for c in FFT_CHANNELS for b in FFT_BANDS)
    rows = conn.execute(text(f"""
        SELECT {cols} FROM fft_band_powers
        WHERE  session_id = CAST(:sid AS uuid)
        ORDER  BY time
    """), {"sid": session_id}).all()
    arr = np.array([[np.nan if v is None else float(v) for v in r] for r in rows],
                   dtype=np.float64)
    return arr.reshape(len(rows), len(FFT_CHANNELS), len(FFT_BANDS))


# A member's "latest session" must show at least this many distinct labelled images.
# Without a floor, a short or aborted recording (one image, say) would replace a full
# 24-image session as that person's contribution to every group they are in.
MIN_SESSION_LABELLED_IMAGES = int(os.getenv("PHASE1_MIN_SESSION_LABELLED_IMAGES", "10"))


def fetch_latest_training_sessions(conn, client_ids: list[str]) -> dict[str, dict]:
    """
    Each client's latest session a group model can learn from: completed (the bridge has
    flushed everything), EEG stored, and at least MIN_SESSION_LABELLED_IMAGES distinct
    OASIS-labelled images shown.

    Returns {client_id: {session_id, start_time, n_labelled_images}}; a client with no
    such session is absent. Same completed/timeline gate as fetch_completed_session_ids.
    """
    if not client_ids:
        return {}
    rows = conn.execute(text("""
        SELECT DISTINCT ON (s.client_id)
               s.client_id, s.session_id, s.start_time, lab.n_labelled_images
        FROM   sessions s
        CROSS  JOIN LATERAL (
            SELECT count(DISTINCT e.image_id) AS n_labelled_images
            FROM   events e JOIN images i ON i.image_id = e.image_id
            WHERE  e.session_id = s.session_id AND e.hidden_at IS NOT NULL
              AND  i.valence_mean IS NOT NULL AND i.arousal_mean IS NOT NULL
        ) lab
        WHERE  s.client_id = ANY(CAST(:ids AS uuid[]))
          AND  s.sync_status = 'completed'
          AND  COALESCE(s.timeline_version, 1) >= :minver
          AND  lab.n_labelled_images >= :min_images
          AND  EXISTS (SELECT 1 FROM eeg_filtered_samples f WHERE f.session_id = s.session_id)
        ORDER  BY s.client_id, s.start_time DESC
    """), {"ids": list(client_ids), "minver": MIN_TIMELINE_VERSION,
           "min_images": MIN_SESSION_LABELLED_IMAGES}).mappings().all()
    return {
        str(r["client_id"]): {
            "session_id": str(r["session_id"]),
            "start_time": r["start_time"],
            "n_labelled_images": int(r["n_labelled_images"]),
        }
        for r in rows
    }


def fetch_client_bfi(conn, client_id: str, prefer_session_id: str | None = None) -> dict | None:
    """
    A client's BFI-2 domain means (1-5) as {E, A, C, N, O, session_id}, or None.

    Taken from prefer_session_id's own BFI-2 when it is complete; otherwise from the
    client's most recent complete BFI-2. Personality is treated as stable, so a session
    with no questionnaire of its own borrows the client's latest one. Only complete
    questionnaires count: a half-answered one would average a different item set per
    domain.
    """
    rows = conn.execute(text("""
        SELECT sc.session_id, sc.domain, sc.mean_score
        FROM   session_questionnaire_scores sc
        JOIN   sessions s ON s.session_id = sc.session_id
        WHERE  s.client_id = :cid
          AND  sc.questionnaire_code = 'bfi2'
          AND  sc.score_level = 'domain'
          AND  EXISTS (SELECT 1 FROM session_questionnaire_scores t
                       WHERE t.session_id = sc.session_id AND t.questionnaire_code = 'bfi2'
                         AND t.score_level = 'total' AND t.is_complete)
        ORDER  BY (sc.session_id = CAST(:prefer AS uuid)) DESC NULLS LAST, s.start_time DESC
    """), {"cid": client_id, "prefer": prefer_session_id}).mappings().all()
    if not rows:
        return None
    chosen = rows[0]["session_id"]
    scores = {r["domain"]: float(r["mean_score"]) for r in rows if r["session_id"] == chosen}
    if any(d not in scores for d in BFI_DOMAINS):
        return None
    return {**{d: scores[d] for d in BFI_DOMAINS}, "session_id": str(chosen)}


def fetch_session_client(conn, session_id: str) -> str | None:
    row = conn.execute(text("SELECT client_id FROM sessions WHERE session_id = :sid"),
                       {"sid": session_id}).first()
    return str(row[0]) if row and row[0] else None


def fetch_client_eligibility(conn) -> list[dict]:
    """
    Every client with what a group model would use from them: their latest trainable
    session (if any) and whether a complete BFI-2 exists. For the group editor, which
    shows up front who can contribute. Cross-clinic: the backend trims it to the
    caller's clinic.
    """
    clients = conn.execute(text("""
        SELECT c.client_id, c.name AS client_name FROM clients c ORDER BY c.name
    """)).mappings().all()
    ids = [str(c["client_id"]) for c in clients]
    latest = fetch_latest_training_sessions(conn, ids)
    with_bfi = {
        str(r[0]) for r in conn.execute(text("""
            SELECT DISTINCT s.client_id
            FROM   session_questionnaire_scores t
            JOIN   sessions s ON s.session_id = t.session_id
            WHERE  t.questionnaire_code = 'bfi2' AND t.score_level = 'total' AND t.is_complete
        """))
    }
    out = []
    for c in clients:
        cid = str(c["client_id"])
        sess = latest.get(cid)
        out.append({
            "client_id": cid,
            "client_name": c["client_name"],
            "latest_session_id": sess["session_id"] if sess else None,
            "latest_session_at": sess["start_time"] if sess else None,
            "n_labelled_images": sess["n_labelled_images"] if sess else 0,
            "has_bfi": cid in with_bfi,
            "eligible": bool(sess) and cid in with_bfi,
        })
    return out


def fetch_timeline_version_mix(conn, session_ids: list[str]) -> dict:
    """
    How many of these sessions came from a compressed vs. an honest timeline.

    Reported on every train. A model fitted across BOTH populations is the worst case:
    part of its data has correct labels and part does not, so its cross-validated score
    describes neither. Surfacing the mix is what stops that going unnoticed.
    """
    if not session_ids:
        return {}
    rows = conn.execute(text("""
        SELECT COALESCE(timeline_version, 1) AS v, count(*) AS n
        FROM   sessions
        WHERE  session_id = ANY(CAST(:ids AS uuid[]))
        GROUP  BY 1 ORDER BY 1
    """), {"ids": session_ids}).mappings().all()
    return {int(r["v"]): int(r["n"]) for r in rows}


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