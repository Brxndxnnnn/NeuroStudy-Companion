import pool from '../config/db.js'
import query from '../utils/query.js'

const findAll = async ({ clinic_id = undefined, sync_status, start_date, end_date }, client = pool) => {
    let sql = `SELECT s.session_id, s.sync_status, s.bridge_recording_at, s.device_id, s.paired_at, s.start_time, s.end_time,
            s.client_id, c.name AS client_name, s.conducted_by, u.display_name AS technician_name FROM sessions s
            LEFT JOIN clients c ON s.client_id = c.client_id
            LEFT JOIN users u ON s.conducted_by = u.user_id`;

    const values = [];

    if (clinic_id !== undefined) {
        sql += ` WHERE s.clinic_id = $${values.length + 1}`;
        values.push(clinic_id);
    }
    if (sync_status !== undefined) {
        sql += ` AND s.sync_status = $${values.length + 1}`;
        values.push(sync_status);
    }
    if (start_date !== undefined) {
        sql += ` AND s.start_time >= $${values.length + 1}`;
        values.push(start_date);
    }
    if (end_date !== undefined) {
        sql += ` AND s.start_time <= $${values.length + 1}`;
        values.push(end_date);
    }

    sql += ` ORDER BY s.start_time DESC NULLS LAST, s.session_id DESC`;

    const { rows } = await query(client, sql, values);
    return rows;
}

const findById = async (session_id, client = pool) => {
    const { rows } = await query(client,
        `SELECT 
            s.session_id, 
            s.sync_status,
            s.bridge_recording_at,
            s.device_id,
            s.paired_at,
            s.start_time,
            s.end_time,
            s.client_id,
            c.name AS client_name,
            s.conducted_by,
            u.display_name AS technician_name,
            -- Status of the elliptic feature job (ml_service computes it after the
            -- bridge marks the session completed). Without these, an empty
            -- elliptic_band_stats response is ambiguous: "still computing", "finished
            -- with nothing" and "the worker crashed" all look identical, and the
            -- results page can only offer a shrug and a retry button.
            s.features_status,
            s.features_error,
            s.features_computed_at
         FROM sessions s
         LEFT JOIN clients c ON s.client_id = c.client_id
         LEFT JOIN users u ON s.conducted_by = u.user_id
         WHERE s.session_id = $1
         ORDER BY s.start_time DESC NULLS LAST, s.session_id DESC`, [session_id]
    )
    return rows
}

const pairSessions = async (pairing_code, client_id, conducted_by, clinic_id, client = pool) => {
    try {
        const { rows } = await query(client, `SELECT claim_session($1, $2, $3, $4) AS session`, [pairing_code, client_id, conducted_by, clinic_id])
        return rows[0] ?? null
    } catch (err) {
        // Catch the specific exception raised by the Postgres function
        if (err.message.includes('Invalid pairing code or session already claimed')) {
            return null
        }
        throw err
    }
}

const startSession = async (session_id, client = pool) => {
    const { rows } = await query(client, `UPDATE sessions SET sync_status = 'recording', start_time = NOW() WHERE session_id = $1 RETURNING *`, [session_id])
    return rows[0] ?? null
}

const endSession = async (session_id, client = pool) => {
    const { rows } = await query(client, `UPDATE sessions SET sync_status = 'completed', end_time = NOW() WHERE session_id = $1 RETURNING *`, [session_id])
    return rows[0] ?? null
}

const getSessionResult = async (session_id, client = pool) => {
    const { rows } = await query(client,
        `WITH event_windows AS (
            SELECT
                e.event_id, e.session_id, e.image_id, e.question_id, e.shown_at,
                -- Fall back to next event or session end if hidden_at is missing
                COALESCE(
                    e.hidden_at,
                    LEAD(e.shown_at) OVER (PARTITION BY e.session_id ORDER BY e.shown_at, e.event_id),
                    s.end_time
                ) AS effective_hidden_at,
                (ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.shown_at, e.event_id))::integer AS sequence_no
            FROM public.events e
            JOIN public.sessions s ON s.session_id = e.session_id
            WHERE e.session_id = $1::uuid
        )
        SELECT
            ew.event_id,
            ew.sequence_no,
            ew.shown_at,
            ew.effective_hidden_at AS hidden_at,
            CASE WHEN ew.image_id IS NOT NULL THEN 'image' ELSE 'question' END AS stimulus_type,
            CASE 
                WHEN ew.effective_hidden_at IS NULL THEN NULL
                ELSE EXTRACT(EPOCH FROM (ew.effective_hidden_at - ew.shown_at))::double precision
            END AS duration_s,
            -- Image & Question specific fields
            ew.image_id, i.filename, i.category, i.url,
            ew.question_id, q.question_no, q.prompt, q.difficulty,
            -- Aggregated statistics
            stats.avg_attention, stats.avg_relaxation, stats.avg_mental_workload,
            stats.avg_heart_rate, stats.avg_spo2, stats.sample_count
        FROM event_windows ew
        LEFT JOIN public.images i ON i.image_id = ew.image_id
        LEFT JOIN public.questions q ON q.question_id = ew.question_id
        LEFT JOIN LATERAL (
            SELECT
                AVG(b.attention)::double precision AS avg_attention,
                AVG(b.relaxation)::double precision AS avg_relaxation,
                AVG(b.mental_workload)::double precision AS avg_mental_workload,
                AVG(b.heart_rate)::double precision AS avg_heart_rate,
                AVG(b.spo2)::double precision AS avg_spo2,
                COUNT(b."time")::integer AS sample_count
            FROM public.band_powers b
            WHERE b.session_id = ew.session_id
            AND ew.effective_hidden_at IS NOT NULL
            -- Account for latency / clock skew
            AND b."time" >= ew.shown_at + ($2::integer * INTERVAL '1 millisecond')
            AND b."time" < ew.effective_hidden_at
        ) stats ON TRUE
        ORDER BY ew.sequence_no ASC;`, [session_id, 300])
    return rows
}
const backfillSessionResults = async (session_id) => {
    const client = await pool.connect();

    try {
        // ✅ Start a transaction to ensure atomicity
        await client.query('BEGIN');
        // 1. Backfill eeg_readings
        await client.query(`
            UPDATE eeg_readings e
            SET current_event_id = ev.event_id
            FROM events ev
            WHERE e.session_id = $1
              AND e.session_id = ev.session_id
              AND e.time >= ev.shown_at
              AND (ev.hidden_at IS NULL OR e.time < ev.hidden_at)
              AND e.current_event_id IS NULL
        `, [session_id]);

        // 2. Backfill band_powers
        await client.query(`
            UPDATE band_powers bp
            SET current_event_id = ev.event_id
            FROM events ev
            WHERE bp.session_id = $1
              AND bp.session_id = ev.session_id
              AND bp.time >= ev.shown_at
              AND (ev.hidden_at IS NULL OR bp.time < ev.hidden_at)
              AND bp.current_event_id IS NULL
        `, [session_id]);

        // ✅ Commit only if BOTH succeed
        await client.query('COMMIT');
    } catch (err) {
        // ✅ Rollback if EITHER fails, preventing partial/inconsistent data
        await client.query('ROLLBACK');
        throw err; // Re-throw so the controller's try/catch can handle it
    } finally {
        await client.release(); // Always release the client back to the pool
    }
};

const getSessionEEGResults = async ({ session_id, sample_rate, start_time, end_time }, fromTs, toTs, rawOrFiltered, client = pool) => {
    const tableName = rawOrFiltered === 'raw' ? 'eeg_raw_samples' : 'eeg_filtered_samples';
    const samplesResult = await client.query(
        `SELECT
        r."time",
        EXTRACT(EPOCH FROM (r."time" - $2::timestamptz))::double precision AS t_seconds,
        r.fp1::double precision AS fp1_left_front,
        r.fp2::double precision AS fp2_right_front,
        r.t3::double precision  AS t3_left_temporal,
        r.t4::double precision  AS t4_right_temporal
    FROM ${tableName} r
    WHERE r.session_id = $1::uuid
      AND r."time" >= $3::timestamptz
      AND r."time" <  $4::timestamptz
    ORDER BY r."time" ASC
    `,
        [session_id, start_time, fromTs, toTs]
    )

    const eventsTimingResult = await client.query(
        `SELECT e.image_id, e.question_id, e.shown_at, e.hidden_at,
            EXTRACT(EPOCH FROM (e.shown_at - $2::timestamptz))::double precision AS shown_at_seconds,
            EXTRACT(EPOCH FROM (e.hidden_at - $2::timestamptz))::double precision AS hidden_at_seconds
        FROM events e
        WHERE e.session_id = $1::uuid
          AND e.shown_at >= $3::timestamptz
          AND e.shown_at < $4::timestamptz
        ORDER BY e.shown_at ASC`,
        [session_id, start_time, fromTs, toTs]
    );

    return {
        session: {
            session_id,
            sample_rate,
            start_time,
            end_time
        },
        sample_length: samplesResult.rowCount,
        samples: samplesResult.rows,
        events_length: eventsTimingResult.rowCount,
        events_timing: eventsTimingResult.rows
    }
}

const getSessionBandPowerResults = async ({ session_id, start_time, end_time }, fromTs, toTs, client = pool) => {
    const samplesResult = await client.query(
        `SELECT s.session_id, b."time", EXTRACT(EPOCH FROM (b."time" - s.start_time))::double precision AS t_seconds,
            b.fp1_alpha,
            b.fp1_beta,
            b.fp1_delta,
            b.fp1_theta,
            b.fp1_gamma,

            b.fp2_alpha,
            b.fp2_beta,
            b.fp2_delta,
            b.fp2_theta,
            b.fp2_gamma,

            b.t3_alpha,
            b.t3_beta,
            b.t3_delta,
            b.t3_theta,
            b.t3_gamma,

            b.t4_alpha,
            b.t4_beta,
            b.t4_delta,
            b.t4_theta,
            b.t4_gamma,

            b.attention,
            b.relaxation,
            b.mental_workload,
            b.signal_quality,
            b.heart_rate,
            b.spo2 FROM band_powers b
            JOIN sessions s ON b.session_id = s.session_id
            WHERE b.session_id = $1::uuid
                AND b."time" >= $2::timestamptz
                AND b."time" <  $3::timestamptz
            ORDER BY b."time" ASC`,
        [session_id, fromTs, toTs]
    )

    return {
        session: {
            session_id,
            start_time,
            end_time
        },
        sample_length: samplesResult.rowCount,
        samples: samplesResult.rows
    };
}

const getEllipticBandStats = async (session_id, client = pool) => {
    const { rows } = await query(client,
        `SELECT * FROM elliptic_band_stats WHERE session_id = $1`, [session_id]
    );
    return rows;
};

export default { findAll, findById, pairSessions, startSession, endSession, getSessionResult, backfillSessionResults, getSessionEEGResults, getSessionBandPowerResults, getEllipticBandStats }