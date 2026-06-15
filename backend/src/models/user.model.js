import pool from '../config/db.js'
import query from '../utils/query.js'

const findByEmail = async (email, client = pool) => {
    const { rows } = await query(client, 
        `SELECT u.user_id, u.email, u.password_hash, u.display_name, u.clinic_id, u.role_id,
                r.name AS role_name
         FROM users u
         JOIN roles r ON u.role_id = r.role_id
         WHERE u.email = $1`,
        [email]
    )
    return rows[0] ?? null
}

const findById = async (user_id, client = pool) => {
    const { rows } = await query(client,
        `SELECT u.user_id, u.email, u.display_name, u.clinic_id, u.role_id, u.created_at, u.assigned_by,
                r.name AS role_name
        FROM users u
        JOIN roles r ON u.role_id = r.role_id
        WHERE u.user_id = $1`,
        [user_id]
    )
    return rows[0] ?? null
}

// Create a new user
const create = async ({ email, password_hash, display_name, clinic_id, role_id, assigned_by }, client = pool) => {
    const { rows } = await query(client,
        `INSERT INTO users (email, password_hash, display_name, clinic_id, role_id, assigned_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING user_id, email, display_name, clinic_id, role_id, created_at`,
        [email, password_hash, display_name, clinic_id, role_id, assigned_by]
    )
    return rows[0]
}

// List all users with their role
const findAll = async (client = pool) => {
    const { rows } = await query(client,
        `SELECT u.user_id, u.email, u.display_name, u.clinic_id, u.created_at, u.assigned_by,
                r.name AS role
         FROM users u
         JOIN roles r ON u.role_id = r.role_id
         ORDER BY u.created_at DESC`
    )
    return rows
}

// Update display_name and/or clinic_id dynamically
const update = async (user_id, fields, client = pool) => {
    const cols = []
    const vals = []
    let idx = 1
    if (fields.display_name !== undefined) { cols.push(`display_name = $${idx++}`); vals.push(fields.display_name) }
    if (fields.clinic_id    !== undefined) { cols.push(`clinic_id = $${idx++}`); vals.push(fields.clinic_id) }
    if (!cols.length) return null
    vals.push(user_id)
    const { rows } = await query(client,
        `UPDATE users SET ${cols.join(', ')}
         WHERE user_id = $${idx}
         RETURNING user_id, email, display_name, clinic_id, role_id, created_at`,
        vals
    )
    return rows[0] ?? null
}

// Soft delete: strip role so they fail all requirePermission checks
const removeRole = async (user_id, client = pool) => {
    // await query(client, 'DELETE FROM user_roles WHERE user_id = $1', [user_id])
}

// Update role (upsert — schema enforces one role per user)
const updateRole = async (user_id, role_id, assigned_by, client = pool) => {
    const { rows } = await query(client,
        `UPDATE users SET role_id = $1, assigned_by = $2
         WHERE user_id = $3
         RETURNING user_id, role_id, assigned_by`,
        [role_id, assigned_by, user_id]
    )
    return rows[0] ?? null
}

// Resolve role name → role_id
const findRoleByName = async (name, client = pool) => {
    const { rows } = await query(client, 'SELECT role_id, name FROM roles WHERE name = $1', [name])
    return rows[0] ?? null
}

export default { findByEmail, findById, findAll, create, update, removeRole, updateRole, findRoleByName }