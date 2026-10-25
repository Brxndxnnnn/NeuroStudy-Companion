import query from '../utils/query.js'

// ML groups (db/migrations/025_ml_group_models.sql): a named set of clients whose latest
// sessions train one Phase 1 model. Every function takes the caller's RLS-scoped
// connection (req.dbClient), so a clinic only ever sees and changes its own groups. The
// member trigger rejects (P2501) a client from another clinic.

const listWithMembers = async (client) => {
    const { rows } = await query(client,
        `SELECT g.group_id, g.clinic_id, g.name, g.created_by, g.created_at, g.updated_at,
                COALESCE(
                    json_agg(json_build_object('client_id', c.client_id, 'client_name', c.name)
                             ORDER BY c.name)
                        FILTER (WHERE c.client_id IS NOT NULL),
                    '[]'
                ) AS members
         FROM ml_groups g
         LEFT JOIN ml_group_members m ON m.group_id = g.group_id
         LEFT JOIN clients c ON c.client_id = m.client_id
         GROUP BY g.group_id
         ORDER BY g.created_at DESC`
    )
    return rows
}

const findById = async (group_id, client) => {
    const { rows } = await query(client,
        'SELECT group_id, clinic_id, name FROM ml_groups WHERE group_id = $1', [group_id])
    return rows[0] ?? null
}

// The clinics the given clients belong to (as the caller can see them).
const clinicsOfClients = async (client_ids, client) => {
    const { rows } = await query(client,
        'SELECT DISTINCT clinic_id FROM clients WHERE client_id = ANY($1::uuid[])', [client_ids])
    return rows.map(r => r.clinic_id)
}

const replaceMembers = async (group_id, client_ids, client) => {
    await query(client,
        'DELETE FROM ml_group_members WHERE group_id = $1 AND NOT (client_id = ANY($2::uuid[]))',
        [group_id, client_ids])
    if (client_ids.length)
        await query(client,
            `INSERT INTO ml_group_members (group_id, client_id)
             SELECT $1, unnest($2::uuid[])
             ON CONFLICT (group_id, client_id) DO NOTHING`,
            [group_id, client_ids])
}

// client must be a dedicated connection (req.dbClient): BEGIN and COMMIT must run on it.
const create = async ({ name, clinic_id, created_by, client_ids }, client) => {
    await query(client, 'BEGIN')
    try {
        const { rows } = await query(client,
            `INSERT INTO ml_groups (name, clinic_id, created_by)
             VALUES ($1, $2, $3)
             RETURNING group_id`, [name, clinic_id, created_by])
        const group_id = rows[0].group_id
        await replaceMembers(group_id, client_ids, client)
        await query(client, 'COMMIT')
        return group_id
    } catch (err) {
        await query(client, 'ROLLBACK')
        throw err
    }
}

// name and/or client_ids; client_ids replaces the whole member list.
const update = async (group_id, { name, client_ids }, client) => {
    await query(client, 'BEGIN')
    try {
        const { rowCount } = await query(client,
            `UPDATE ml_groups SET name = COALESCE($2, name), updated_at = now()
             WHERE group_id = $1`, [group_id, name ?? null])
        if (rowCount === 0) {
            await query(client, 'ROLLBACK')
            return false
        }
        if (client_ids) await replaceMembers(group_id, client_ids, client)
        await query(client, 'COMMIT')
        return true
    } catch (err) {
        await query(client, 'ROLLBACK')
        throw err
    }
}

// Deleting a group deletes its models and their predictions (ON DELETE CASCADE).
const remove = async (group_id, client) => {
    const { rowCount } = await query(client, 'DELETE FROM ml_groups WHERE group_id = $1', [group_id])
    return rowCount > 0
}

export default { listWithMembers, findById, clinicsOfClients, create, update, remove }
