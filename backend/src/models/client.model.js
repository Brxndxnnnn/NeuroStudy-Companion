import pool from '../config/db.js'
import query from '../utils/query.js'
import clientHistoryModel from './clientHistory.model.js'

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

// Registration: a client cannot be paired without a published history (claim_session
// raises P2006), so the client and its first history are created together. Rolling
// back on any failure means a client never exists without one.
// client must be a dedicated connection (req.dbClient), not the pool.
const createWithHistory = async (clientData, history, user_id, client) => {
    await query(client, 'BEGIN')
    try {
        const newClient = await create(clientData, client)
        const history_id = await clientHistoryModel.createPublished(newClient.client_id, history, user_id, client)
        await query(client, 'COMMIT')
        return { client: newClient, history_id }
    } catch (err) {
        await query(client, 'ROLLBACK')
        throw err
    }
}

export default { findAll, findById, create, createWithHistory }