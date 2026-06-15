import pool from '../config/db.js'
import query from '../utils/query.js'

const findAll = async (client = pool) => {
    const { rows } = await query(client, 
        `SELECT 
            s.session_id, 
            s.sync_status,
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

export default { findAll, pairSessions }