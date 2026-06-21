import pool from '../config/db.js'
import query from '../utils/query.js'

const findAll = async (client = pool) => {
    const { rows } = await query(client, 
        `SELECT * from clients ORDER BY created_at DESC NULLS LAST, client_id DESC`
    )
    return rows
}

const findById = async (client_id, client = pool) => {
    const { rows } = await query(client, 
        `SELECT * from clients WHERE client_id = $1 ORDER BY created_at DESC NULLS LAST, client_id DESC`, [client_id]
    )
    return rows
}

export default { findAll, findById }