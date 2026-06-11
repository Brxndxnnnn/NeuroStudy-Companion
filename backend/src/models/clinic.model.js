import pool from '../config/db.js'
import query from '../utils/query.js'

const findAll = async (client = pool) => {
    const { rows } = await query(client, 
        `SELECT clinic_id, name, address, created_at
         FROM clinics
         ORDER BY created_at DESC`
    )
    return rows
}

const findById = async (clinic_id, client = pool) => {
    const { rows } = await query(client,
        `SELECT clinic_id, name, address, created_at
         FROM clinics
         WHERE clinic_id = $1`,
        [clinic_id]
    )
    return rows[0] ?? null
}

const create = async ({ name, address = null }, client = pool) => {
    const { rows } = await query(client,
        `INSERT INTO clinics (name, address)
         VALUES ($1, $2)
         RETURNING clinic_id, name, address, created_at`,
        [name, address]
    )
    return rows[0]
}

const update = async (clinic_id, fields, client = pool) => {
    const cols = []
    const vals = []
    let idx = 1

    if (fields.name    !== undefined) { cols.push(`name    = $${idx++}`); vals.push(fields.name)    }
    if (fields.address !== undefined) { cols.push(`address = $${idx++}`); vals.push(fields.address) }

    if (!cols.length) return null  // nothing to update

    vals.push(clinic_id)
    const { rows } = await query(client,
        `UPDATE clinics
         SET ${cols.join(', ')}
         WHERE clinic_id = $${idx}
         RETURNING clinic_id, name, address, created_at`,
        vals
    )
    return rows[0] ?? undefined  // undefined = not found, null = nothing to update
}

export default { findAll, findById, create, update }