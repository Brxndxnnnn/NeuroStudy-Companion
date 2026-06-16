"""
data_access/writer.py

All INSERT/UPDATE queries the ML service writes to the database.

Tables written:
  - band_powers  : computed band power values per window
  - ml_insights  : generated insight payloads

All functions accept an open SQLAlchemy connection so the caller controls
the transaction boundary. Uses ON CONFLICT DO NOTHING for idempotency —
safe to re-run if the pipeline is triggered twice for the same session.
"""

import uuid
from datetime import datetime, timezone
from sqlalchemy import text


# ── band_powers ────────────────────────────────────────────────────────────────

def write_band_powers(conn, session_id: str, band_power_rows: list[dict]) -> int:
    """
    Insert computed band power rows into band_powers hypertable.

    Each dict in band_power_rows must contain:
      time             : datetime — window centre timestamp
      current_image_id : str | None — image shown during this window
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
            session_id, time, current_image_id,
            attention, relaxation, mental_workload, signal_quality,
            fp1_alpha, fp1_beta, fp1_delta, fp1_theta, fp1_gamma,
            fp2_alpha, fp2_beta, fp2_delta, fp2_theta, fp2_gamma,
            t3_alpha,  t3_beta,  t3_delta,  t3_theta,  t3_gamma,
            t4_alpha,  t4_beta,  t4_delta,  t4_theta,  t4_gamma
        ) VALUES (
            :session_id, :time, :current_image_id,
            :attention, :relaxation, :mental_workload, :signal_quality,
            :fp1_alpha, :fp1_beta, :fp1_delta, :fp1_theta, :fp1_gamma,
            :fp2_alpha, :fp2_beta, :fp2_delta, :fp2_theta, :fp2_gamma,
            :t3_alpha,  :t3_beta,  :t3_delta,  :t3_theta,  :t3_gamma,
            :t4_alpha,  :t4_beta,  :t4_delta,  :t4_theta,  :t4_gamma
        )
        ON CONFLICT (session_id, time) DO NOTHING
    """), rows_with_session)

    return len(rows_with_session)


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