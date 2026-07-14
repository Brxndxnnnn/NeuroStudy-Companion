"""
data_access/writer.py

All INSERT/UPDATE queries the ML service writes to the database.

Tables written:
  - band_powers          : SDK band power values per window
  - elliptic_band_stats  : elliptic-filter-computed mean/std/peak per band
                           per channel per sliding window
  - ml_insights          : generated insight payloads

All functions accept an open SQLAlchemy connection so the caller controls
the transaction boundary. Uses ON CONFLICT DO NOTHING for idempotency —
safe to re-run if the pipeline is triggered twice for the same session.
"""

import uuid
from datetime import datetime, timedelta, timezone
from sqlalchemy import text
from app.data_access.queries import fetch_session


# ── band_powers ────────────────────────────────────────────────────────────────

def write_band_powers(conn, session_id: str, band_power_rows: list[dict]) -> int:
    """
    Insert computed band power rows into band_powers hypertable.

    Each dict in band_power_rows must contain:
      time             : datetime — window centre timestamp
      current_event_id : str | None — event active during this window
      fp1_alpha, fp1_beta, fp1_delta, fp1_theta, fp1_gamma : float
      fp2_alpha, fp2_beta, fp2_delta, fp2_theta, fp2_gamma : float
      t3_alpha,  t3_beta,  t3_delta,  t3_theta,  t3_gamma  : float
      t4_alpha,  t4_beta,  t4_delta,  t4_theta,  t4_gamma  : float

    Optional (can be None if not computed):
      attention, relaxation, mental_workload, signal_quality

    Returns:
        Number of rows inserted.
    """
    if not band_power_rows:
        return 0

    rows_with_session = [
        {"session_id": session_id, **row}
        for row in band_power_rows
    ]

    conn.execute(text("""
        INSERT INTO band_powers (
            session_id, time, current_event_id,
            attention, relaxation, mental_workload, signal_quality,
            fp1_alpha, fp1_beta, fp1_delta, fp1_theta, fp1_gamma,
            fp2_alpha, fp2_beta, fp2_delta, fp2_theta, fp2_gamma,
            t3_alpha,  t3_beta,  t3_delta,  t3_theta,  t3_gamma,
            t4_alpha,  t4_beta,  t4_delta,  t4_theta,  t4_gamma
        ) VALUES (
            :session_id, :time, :current_event_id,
            :attention, :relaxation, :mental_workload, :signal_quality,
            :fp1_alpha, :fp1_beta, :fp1_delta, :fp1_theta, :fp1_gamma,
            :fp2_alpha, :fp2_beta, :fp2_delta, :fp2_theta, :fp2_gamma,
            :t3_alpha,  :t3_beta,  :t3_delta,  :t3_theta,  :t3_gamma,
            :t4_alpha,  :t4_beta,  :t4_delta,  :t4_theta,  :t4_gamma
        )
        ON CONFLICT (session_id, time) DO NOTHING
    """), rows_with_session)

    return len(rows_with_session)


# ── elliptic_band_stats ────────────────────────────────────────────────────────

def write_elliptic_band_stats(
    conn,
    session_id:    str,
    windows:       list[dict],
    window_size_s: float,
    step_s:        float,
) -> int:
    """
    Insert elliptic band statistics into elliptic_band_stats hypertable.

    Converts the output of elliptic_sliding_multichannel() directly into
    DB rows — one row per (window, channel) combination, with all 5 bands
    as columns (15 columns total: delta/theta/alpha/beta/gamma × mean/std/peak).

    For a session with N windows and 4 channels this inserts N x 4 rows.
    Each row includes window_number (1, 2, 3, ...) for easy ordering
    without parsing timestamps.

    Args:
        conn:          Open SQLAlchemy connection.
        session_id:    UUID string of the session being written.
        windows:       List of window dicts from elliptic_sliding_multichannel(),
                       each containing:
                         {
                           "time_start": float,   -- seconds from signal start
                           "time_end":   float,   -- seconds from signal start
                           "features": {
                             "fp1": {
                               "delta": {"mean":, "std":, "peak":},
                               "theta": {"mean":, "std":, "peak":},
                               "alpha": {"mean":, "std":, "peak":},
                               "beta":  {"mean":, "std":, "peak":},
                               "gamma": {"mean":, "std":, "peak":},
                             },
                             "fp2": {...}, "t3": {...}, "t4": {...},
                           }
                         }
        window_size_s: Analysis window size in seconds — stored in DB so
                       rows from different window sizes can be distinguished.
        step_s:        Step between windows in seconds — stored in DB.

    Returns:
        Total number of rows inserted (= N windows x 4 channels).

    Note:
        time_start and time_end in the windows list are floats (seconds offset
        from the start of the signal). This function converts them to proper
        timestamptz values by calling fetch_session() to get session start_time,
        then adding the offset. This keeps raw SQL confined to queries.py while
        still allowing a convenient single-call interface for callers.

        Conscious trade-off: the writer triggers one SELECT (via fetch_session)
        in addition to the INSERT. The alternative is for callers to resolve
        session_start themselves and pass absolute datetimes in — stricter
        separation but more wiring. Convenience is preferred here since the
        caller would always need fetch_session anyway.
    """
    if not windows:
        return 0

    # Reuse fetch_session() from queries.py — keeps raw SQL confined to queries.py
    session = fetch_session(conn, session_id)
    if session is None:
        raise ValueError(f"Session {session_id} not found — cannot compute timestamps.")

    session_start = session["start_time"]

    rows = []
    for window_number, w in enumerate(windows, start=1):
        time_start = session_start + timedelta(seconds=w["time_start"])
        time_end   = session_start + timedelta(seconds=w["time_end"])

        for channel, band_stats in w["features"].items():
            rows.append({
                "session_id":    session_id,
                "time_start":    time_start,
                "time_end":      time_end,
                "window_size_s": window_size_s,
                "step_s":        step_s,
                "channel":       channel,
                "window_number": window_number,
                # delta
                "delta_mean":    band_stats["delta"]["mean"],
                "delta_std":     band_stats["delta"]["std"],
                "delta_peak":    band_stats["delta"]["peak"],
                # theta
                "theta_mean":    band_stats["theta"]["mean"],
                "theta_std":     band_stats["theta"]["std"],
                "theta_peak":    band_stats["theta"]["peak"],
                # alpha
                "alpha_mean":    band_stats["alpha"]["mean"],
                "alpha_std":     band_stats["alpha"]["std"],
                "alpha_peak":    band_stats["alpha"]["peak"],
                # beta
                "beta_mean":     band_stats["beta"]["mean"],
                "beta_std":      band_stats["beta"]["std"],
                "beta_peak":     band_stats["beta"]["peak"],
                # gamma
                "gamma_mean":    band_stats["gamma"]["mean"],
                "gamma_std":     band_stats["gamma"]["std"],
                "gamma_peak":    band_stats["gamma"]["peak"],
            })

    conn.execute(text("""
        INSERT INTO elliptic_band_stats (
            session_id, time_start, time_end,
            window_size_s, step_s, channel, window_number,
            delta_mean, delta_std, delta_peak,
            theta_mean, theta_std, theta_peak,
            alpha_mean, alpha_std, alpha_peak,
            beta_mean,  beta_std,  beta_peak,
            gamma_mean, gamma_std, gamma_peak
        ) VALUES (
            :session_id, :time_start, :time_end,
            :window_size_s, :step_s, :channel, :window_number,
            :delta_mean, :delta_std, :delta_peak,
            :theta_mean, :theta_std, :theta_peak,
            :alpha_mean, :alpha_std, :alpha_peak,
            :beta_mean,  :beta_std,  :beta_peak,
            :gamma_mean, :gamma_std, :gamma_peak
        )
        ON CONFLICT (session_id, time_start, channel, window_size_s)
        DO NOTHING
    """), rows)

    return len(rows)


# ── ml_insights ────────────────────────────────────────────────────────────────

def write_insight(
    conn,
    client_id:     str,
    insight_type:  str,
    payload:       dict,
    session_id:    str  = None,
    clinic_id:     str  = None,
    model_version: str  = None,
    trigger:       str  = None,
    status:        str  = "ready",
) -> str:
    """
    Insert one ML insight into ml_insights.

    Args:
        conn:          SQLAlchemy connection.
        client_id:     UUID string — required, not nullable.
        insight_type:  One of: peak_focus_window | session_decay |
                       stimulus_response | session_classification
        payload:       Dict — will be stored as JSONB.
        session_id:    UUID string | None (client-level insights have no session).
        clinic_id:     UUID string | None.
        model_version: String identifying model version (e.g. "v1.0").
        trigger:       What triggered inference — e.g. "session_end" | "manual".
        status:        "ready" | "pending" | "error". Defaults to "ready".

    Returns:
        insight_id: UUID string of the inserted row.
    """
    import json
    insight_id = str(uuid.uuid4())

    conn.execute(text("""
        INSERT INTO ml_insights (
            insight_id, client_id, session_id, clinic_id,
            generated_at, insight_type, payload,
            model_version, trigger, status
        ) VALUES (
            :insight_id, :client_id, :session_id, :clinic_id,
            :generated_at, :insight_type, :payload::jsonb,
            :model_version, :trigger, :status
        )
        ON CONFLICT (insight_id) DO NOTHING
    """), {
        "insight_id":    insight_id,
        "client_id":     client_id,
        "session_id":    session_id,
        "clinic_id":     clinic_id,
        "generated_at":  datetime.now(timezone.utc),
        "insight_type":  insight_type,
        "payload":       json.dumps(payload),
        "model_version": model_version,
        "trigger":       trigger,
        "status":        status,
    })

    return insight_id


def update_insight_status(conn, insight_id: str, status: str) -> None:
    """
    Update the status of an existing insight.
    Used to mark insights as 'ready' after async processing, or 'error' on failure.
    """
    conn.execute(text("""
        UPDATE ml_insights
        SET    status = :status
        WHERE  insight_id = :insight_id
    """), {"insight_id": insight_id, "status": status})