import pool from '../config/db.js'
import query from '../utils/query.js'

const findAll = async (client = pool) => {
    const { rows } = await query(client, 
        `SELECT image_id, display_order, filename, url, category, valence_score, arousal_score from images ORDER BY display_order NULLS LAST, image_id DESC`
    )
    return rows
}

const findById = async (image_id, client = pool) => {
    const { rows } = await query(client, 
        `SELECT image_id, display_order, filename, url, category, valence_score, arousal_score from images WHERE image_id = $1`, [image_id]
    )
    return rows
}

export default { findAll, findById }