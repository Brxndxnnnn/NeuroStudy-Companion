import pool from '../config/db.js'

const findAll = async () => {
    const { rows } = await pool.query(
        `SELECT clinic_id, name, address, created_at
         FROM clinics
         ORDER BY created_at DESC`
    )
    return rows
}

const findById = async (clinic_id) => {
    const { rows } = await pool.query(
        `SELECT clinic_id, name, address, created_at
         FROM clinics
         WHERE clinic_id = $1`,
        [clinic_id]
    )
    return rows[0] ?? null
}

const create = async ({ name, address = null }) => {
    const { rows } = await pool.query(
        `INSERT INTO clinics (name, address)
         VALUES ($1, $2)
         RETURNING clinic_id, name, address, created_at`,
        [name, address]
    )
    return rows[0]
}

const update = async (clinic_id, fields) => {
    const cols = []
    const vals = []
    let idx = 1

    if (fields.name    !== undefined) { cols.push(`name    = $${idx++}`); vals.push(fields.name)    }
    if (fields.address !== undefined) { cols.push(`address = $${idx++}`); vals.push(fields.address) }

    if (!cols.length) return null  // nothing to update

    vals.push(clinic_id)
    const { rows } = await pool.query(
        `UPDATE clinics
         SET ${cols.join(', ')}
         WHERE clinic_id = $${idx}
         RETURNING clinic_id, name, address, created_at`,
        vals
    )
    return rows[0] ?? undefined  // undefined = not found, null = nothing to update
}

export default { findAll, findById, create, update }