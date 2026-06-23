import pool from '../config/db.js'
import query from '../utils/query.js'

const findAll = async (client = pool) => {
    const { rows } = await query(client, 
        `SELECT * from questions ORDER BY question_no ASC`
    )
    return rows
}

const findById = async (question_id, client = pool) => {
    const { rows } = await query(client, 
        `SELECT * from questions WHERE question_id = $1`, [question_id]
    )
    return rows
}

export default { findAll, findById }