import clientModel from '../models/client.model.js'
import catchAsync  from '../utils/catchAsync.js'

// ── GET /api/clients ─────────────────────────────────────────────────────────────
const listClients = catchAsync(async (req, res) => {
    const clients = await clientModel.findAll(req.dbClient)
    return res.json(clients)
})

// ── GET /api/clients/:client_id ────────────────────────────────────────────────
const getClientById = catchAsync(async (req, res) => {
    const { client_id } = req.params
    let results

    try {
        results = await clientModel.findById(client_id, req.dbClient)
    } catch (err) {
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid client_id format' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    }

    if (!results || results.length === 0) {
        return res.status(404).json({ error: 'Client not found' })
    }

    return res.json(results[0])
})

export default { listClients, getClientById }