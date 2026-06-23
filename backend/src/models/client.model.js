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

const create = async ({ name, dob, gender, race, notes, clinic_id }, client = pool) => {
    const { rows } = await query(client,
        `INSERT INTO clients (name, dob, gender, race, notes, clinic_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`, [name, dob, gender, race, notes, clinic_id]
    )
    return rows[0]
}

export default { findAll, findById, create }