import pool from '../config/db.js'

const findByEmail = async (email) => {
    const { rows } = await pool.query(
        `SELECT u.user_id, u.email, u.password_hash, u.display_name, u.clinic_id,
                r.role_id, r.name AS role_name
         FROM users u
         LEFT JOIN user_roles ur ON u.user_id = ur.user_id
         LEFT JOIN roles r ON ur.role_id = r.role_id
         WHERE u.email = $1`,
        [email]
    )
    return rows[0] ?? null
}

const findById = async (user_id) => {
    const { rows } = await pool.query(
        `SELECT u.user_id, u.email, u.display_name, u.clinic_id,
                r.role_id, r.name AS role_name
         FROM users u
         LEFT JOIN user_roles ur ON u.user_id = ur.user_id
         LEFT JOIN roles r ON ur.role_id = r.role_id
         WHERE u.user_id = $1`,
        [user_id]
    )
    return rows[0] ?? null
}

// Create a new user
const create = async ({ email, password_hash, display_name = null, clinic_id = null, role_id, assigned_by }) => {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        const { rows: userRows } = await client.query(
            `INSERT INTO users (email, password_hash, display_name, clinic_id)
             VALUES ($1, $2, $3, $4)
             RETURNING user_id, email, display_name, clinic_id, created_at`,
            [email, password_hash, display_name, clinic_id]
        )
        const user = userRows[0]

        const { rows: roleRows } = await client.query(
            `INSERT INTO user_roles (user_id, role_id, assigned_by)
             VALUES ($1, $2, $3)
             RETURNING role_id`,
            [user.user_id, role_id, assigned_by]
        )

        await client.query('COMMIT')
        return { ...user, role_id: roleRows[0].role_id }
    } catch (err) {
        await client.query('ROLLBACK')
        throw err
    } finally {
        client.release()
    }
}

// List all users with their role
const findAll = async () => {
    const { rows } = await pool.query(
        `SELECT u.user_id, u.email, u.display_name, u.clinic_id, u.created_at,
                r.name AS role, ur.assigned_at
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.user_id
         LEFT JOIN roles r       ON r.role_id  = ur.role_id
         ORDER BY u.created_at DESC`
    )
    return rows
}

// Update display_name and/or clinic_id dynamically
const update = async (user_id, fields) => {
    const cols = []
    const vals = []
    let idx = 1
    if (fields.display_name !== undefined) { cols.push(`display_name = $${idx++}`); vals.push(fields.display_name) }
    if (fields.clinic_id    !== undefined) { cols.push(`clinic_id    = $${idx++}`); vals.push(fields.clinic_id)    }
    if (!cols.length) return null
    vals.push(user_id)
    const { rows } = await pool.query(
        `UPDATE users SET ${cols.join(', ')}
         WHERE user_id = $${idx}
         RETURNING user_id, email, display_name, clinic_id, created_at`,
        vals
    )
    return rows[0] ?? null
}

// Soft delete: strip role so they fail all requirePermission checks
const removeRole = async (user_id) => {
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [user_id])
}

// Assign or replace role (upsert — schema enforces one role per user)
const upsertRole = async (user_id, role_id, assigned_by) => {
    const { rows } = await pool.query(
        `INSERT INTO user_roles (user_id, role_id, assigned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET role_id     = EXCLUDED.role_id,
               assigned_at = now(),
               assigned_by = EXCLUDED.assigned_by
         RETURNING user_id, role_id, assigned_at`,
        [user_id, role_id, assigned_by]
    )
    return rows[0]
}

// Resolve role name → role_id
const findRoleByName = async (name) => {
    const { rows } = await pool.query('SELECT role_id FROM roles WHERE name = $1', [name])
    return rows[0] ?? null
}

export default { findByEmail, findById, findAll, create, update, removeRole, upsertRole, findRoleByName }