import pool from '../config/db.js'
import query from '../utils/query.js'

const create = async ({ session_id, image_id, clinic_id }, client = pool) => {
    const { rows } = await query(client,
        `INSERT INTO events (session_id, image_id, clinic_id, shown_at)
         VALUES ($1, $2, $3, now())
         RETURNING *`, [session_id, image_id, clinic_id]
    )
    return rows[0]
}

const setHiddenAt = async (event_id, client = pool) => {
    const { rows } = await query(client,
        `UPDATE events SET hidden_at = now() WHERE event_id = $1 RETURNING *`, [event_id]
    )
    return rows[0]
}

export default { create, setHiddenAt }