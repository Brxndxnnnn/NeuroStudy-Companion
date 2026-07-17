"""
data_access/writer.py

All INSERT/UPDATE queries the ML service writes to the database.

Tables written:
  - band_powers          : SDK band power values per window
  - elliptic_band_stats  : elliptic-filter-computed mean/std/peak per band
                           per channel per sliding window
  - ml_insights          : generated insight payloads

All functions accept an open SQLAlchemy connection so the caller controls
the transaction boundary.

On re-running: elliptic_band_stats UPSERTS (ON CONFLICT DO UPDATE), so recomputing a
session overwrites its rows with the new values. DO NOTHING was not enough — it makes
a re-run safe from duplicates but incapable of CORRECTING anything, so a recompute
after a bug fix would quietly keep the old numbers and report success.

band_powers still uses DO NOTHING, on purpose: that table belongs to the bridge, and a
collision there must never overwrite what the bridge recorded live.
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
      current_event_id : str | None — event active during this window
      fp1_alpha, fp1_beta, fp1_delta, fp1_theta, fp1_gamma : float
      fp2_alpha, fp2_beta, fp2_delta, fp2_theta, fp2_gamma : float
      t3_alpha,  t3_beta,  t3_delta,  t3_theta,  t3_gamma  : float
      t4_alpha,  t4_beta,  t4_delta,  t4_theta,  t4_gamma  : float

    Optional (can be None if not computed):
      attention, relaxation, mental_workload, signal_quality

    Returns:
        Number of rows actually written.

    ⚠ band_powers IS THE BRIDGE'S TABLE. The bridge writes it live during a
    recording, at ~1 Hz, from its own FFT — and those are POWER values in µV².
    Anything the ML service writes here is interleaved, on the same session and the
    same time axis, with no column saying which producer it came from. The results
    page reads this table and would plot the two as one series.

    Nothing in the ML service calls this today, and it should stay that way. Derived
    features belong in their own table (elliptic_band_stats is the precedent). If a
    use for this ever appears, it needs a producer column and a conversation first.
    """
    if not band_power_rows:
        return 0

    rows_with_session = [
        {"session_id": session_id, **row}
        for row in band_power_rows
    ]

    result = conn.execute(text("""
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

    # The DB's count, not the caller's hope. DO NOTHING is kept here deliberately —
    # colliding with a row the BRIDGE wrote must never overwrite it — so a run that
    # writes nothing must be able to say so.
    return result.rowcount if result.rowcount is not None and result.rowcount >= 0 else 0


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
        time_start / time_end must be ABSOLUTE datetimes, as produced by
        elliptic_sliding_multichannel() when it is given the sample times.

        This used to take float offsets and rebase them onto sessions.start_time,
        which was wrong twice over:

          * start_time is not when the EEG starts. The bridge anchors its clock to
            the first frame it receives, which lands anywhere from -0.3 s to +1.2 s
            from start_time across the recorded sessions. Every window was shifted
            by that much.

          * offsets came from sample INDEX / 250 Hz, which assumes the recording has
            no gaps. It has gaps — real ones, where Bluetooth dropped, from 13 s to
            66 s per session. So the error compounded: the late windows of session
            1087fe73 were landing FIFTY-ONE SECONDS from the EEG they described,
            attributed to the wrong stimulus entirely, with nothing reporting a fault.

        Timestamps now come from the samples themselves, so there is nothing left to
        rebase and nothing to drift.
    """
    if not windows:
        return 0

    rows = []
    for window_number, w in enumerate(windows, start=1):
        time_start = w["time_start"]
        time_end   = w["time_end"]

        if not isinstance(time_start, datetime) or not isinstance(time_end, datetime):
            raise TypeError(
                "write_elliptic_band_stats needs ABSOLUTE datetimes. Got "
                f"{type(time_start).__name__} — the caller is passing float offsets, "
                "which is what used to shift every window off its own EEG. Pass "
                "times= to elliptic_sliding_multichannel()."
            )

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

    # DO UPDATE, not DO NOTHING. DO NOTHING is idempotent only in the sense that it
    # cannot duplicate a row — it also cannot CORRECT one. Recomputing a session after
    # fixing the filter, or retrying a job that was reclaimed mid-run, would have
    # silently kept the old values and reported success. An upsert overwrites, so a
    # recompute means what it says.
    result = conn.execute(text("""
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
        DO UPDATE SET
            time_end      = EXCLUDED.time_end,
            step_s        = EXCLUDED.step_s,
            window_number = EXCLUDED.window_number,
            delta_mean    = EXCLUDED.delta_mean,
            delta_std     = EXCLUDED.delta_std,
            delta_peak    = EXCLUDED.delta_peak,
            theta_mean    = EXCLUDED.theta_mean,
            theta_std     = EXCLUDED.theta_std,
            theta_peak    = EXCLUDED.theta_peak,
            alpha_mean    = EXCLUDED.alpha_mean,
            alpha_std     = EXCLUDED.alpha_std,
            alpha_peak    = EXCLUDED.alpha_peak,
            beta_mean     = EXCLUDED.beta_mean,
            beta_std      = EXCLUDED.beta_std,
            beta_peak     = EXCLUDED.beta_peak,
            gamma_mean    = EXCLUDED.gamma_mean,
            gamma_std     = EXCLUDED.gamma_std,
            gamma_peak    = EXCLUDED.gamma_peak
    """), rows)

    # What the DB actually did, not what we asked it to do. len(rows) was the number
    # of rows ATTEMPTED — under DO NOTHING it happily reported thousands of writes on a
    # run that changed nothing at all.
    return result.rowcount if result.rowcount is not None and result.rowcount >= 0 else len(rows)


# ── fft_band_powers ──────────────────────────────────────────────────────────

def write_fft_band_powers(
    conn,
    session_id:    str,
    windows:       list[dict],
    window_size_s: float,
    step_s:        float,
) -> int:
    """
    Insert our FFT-computed band powers into fft_band_powers — one WIDE row per window
    (all 4 channels × 5 bands as columns), mirroring band_powers' column names so the
    read endpoint and frontend transform stay almost identical to the SDK path.

    Args:
        windows: List from fft_band_powers_sliding(), each:
                   {"time": datetime,   -- window centre (absolute)
                    "powers": {"fp1": {"delta":.., "theta":.., "alpha":.., "beta":..,
                                       "gamma":..}, "fp2": {...}, "t3": {...}, "t4": {...}}}
        window_size_s / step_s: stored for provenance.

    Returns the DB's actual affected-row count.

    ON CONFLICT DO UPDATE so a recompute (backfill, changed window, reclaimed job)
    overwrites rather than silently keeping stale values. The adapter also DELETEs the
    session's rows before calling this, so a shrink in window count can't leave orphans.
    """
    if not windows:
        return 0

    rows = []
    for w in windows:
        time  = w["time"]
        if not isinstance(time, datetime):
            raise TypeError(
                "write_fft_band_powers needs an ABSOLUTE datetime for 'time'; got "
                f"{type(time).__name__}. Pass sample times through "
                "fft_band_powers_sliding() so windows carry a real clock timestamp."
            )
        p = w["powers"]
        row = {"session_id": session_id, "time": time,
               "window_size_s": window_size_s, "step_s": step_s}
        for ch in ("fp1", "fp2", "t3", "t4"):
            for band in ("delta", "theta", "alpha", "beta", "gamma"):
                row[f"{ch}_{band}"] = p[ch][band]
        rows.append(row)

    result = conn.execute(text("""
        INSERT INTO fft_band_powers (
            session_id, time, window_size_s, step_s,
            fp1_delta, fp1_theta, fp1_alpha, fp1_beta, fp1_gamma,
            fp2_delta, fp2_theta, fp2_alpha, fp2_beta, fp2_gamma,
            t3_delta,  t3_theta,  t3_alpha,  t3_beta,  t3_gamma,
            t4_delta,  t4_theta,  t4_alpha,  t4_beta,  t4_gamma
        ) VALUES (
            :session_id, :time, :window_size_s, :step_s,
            :fp1_delta, :fp1_theta, :fp1_alpha, :fp1_beta, :fp1_gamma,
            :fp2_delta, :fp2_theta, :fp2_alpha, :fp2_beta, :fp2_gamma,
            :t3_delta,  :t3_theta,  :t3_alpha,  :t3_beta,  :t3_gamma,
            :t4_delta,  :t4_theta,  :t4_alpha,  :t4_beta,  :t4_gamma
        )
        ON CONFLICT (session_id, time) DO UPDATE SET
            window_size_s = EXCLUDED.window_size_s,
            step_s        = EXCLUDED.step_s,
            fp1_delta = EXCLUDED.fp1_delta, fp1_theta = EXCLUDED.fp1_theta,
            fp1_alpha = EXCLUDED.fp1_alpha, fp1_beta  = EXCLUDED.fp1_beta,
            fp1_gamma = EXCLUDED.fp1_gamma,
            fp2_delta = EXCLUDED.fp2_delta, fp2_theta = EXCLUDED.fp2_theta,
            fp2_alpha = EXCLUDED.fp2_alpha, fp2_beta  = EXCLUDED.fp2_beta,
            fp2_gamma = EXCLUDED.fp2_gamma,
            t3_delta  = EXCLUDED.t3_delta,  t3_theta  = EXCLUDED.t3_theta,
            t3_alpha  = EXCLUDED.t3_alpha,  t3_beta   = EXCLUDED.t3_beta,
            t3_gamma  = EXCLUDED.t3_gamma,
            t4_delta  = EXCLUDED.t4_delta,  t4_theta  = EXCLUDED.t4_theta,
            t4_alpha  = EXCLUDED.t4_alpha,  t4_beta   = EXCLUDED.t4_beta,
            t4_gamma  = EXCLUDED.t4_gamma
    """), rows)

    return result.rowcount if result.rowcount is not None and result.rowcount >= 0 else len(rows)


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