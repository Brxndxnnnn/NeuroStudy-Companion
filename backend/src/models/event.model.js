import pool from '../config/db.js'
import query from '../utils/query.js'

const create = async ({ session_id, image_id, question_id, clinic_id }, client = pool) => {
    let queryText = `INSERT INTO events (session_id, `
    if (image_id) queryText += `image_id, `
    if (question_id) queryText += `question_id, `
    queryText += `clinic_id, shown_at) VALUES ($1, $2, $3, now()) RETURNING *`
    const queryParams = [session_id, image_id ? image_id : question_id, clinic_id]
    const { rows } = await query(client, queryText, queryParams)
    return rows[0]
}

const setHiddenAt = async (event_id, client = pool) => {
    const { rows } = await query(client,
        `UPDATE events SET hidden_at = now() WHERE event_id = $1 RETURNING *`, [event_id]
    )
    return rows[0]
}

export default { create, setHiddenAt }