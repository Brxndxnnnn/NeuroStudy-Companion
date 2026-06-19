import pool from '../config/db.js'
import query from '../utils/query.js'

const findAll = async (client = pool) => {
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
            u.display_name AS technician_name
         FROM sessions s
         LEFT JOIN clients c ON s.client_id = c.client_id
         LEFT JOIN users u ON s.conducted_by = u.user_id
         ORDER BY s.start_time DESC NULLS LAST, s.session_id DESC`
    )
    return rows
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
            u.display_name AS technician_name
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
        const { rows } = await query(client, `SELECT claim_session($1, $2, $3, $4) AS session`,[pairing_code, client_id, conducted_by, clinic_id])
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
        `SELECT e.image_id, avg(b.attention)  AS avg_attention, avg(b.relaxation) AS avg_relaxation
        FROM events e JOIN band_powers b ON b.session_id = e.session_id AND b.time >= e.shown_at + interval '300 ms' AND b.time < e.hidden_at
        WHERE e.session_id = $1 GROUP BY e.image_id`, [session_id]
    )
    return rows
}
export default { findAll, findById, pairSessions, startSession, endSession, getSessionResult }