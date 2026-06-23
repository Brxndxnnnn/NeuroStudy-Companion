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

const createClient = catchAsync(async (req, res) => {
    const { name, dob, gender, race, notes } = req.body

    if (!name || !dob || !gender || !race) {
        return res.status(400).json({ error: 'Missing required fields: name, dob, gender, and race are required' })
    }

    let clinic_id = req.user.clinic_id // from JWT for technician, but allow override for admin users to create clients for other clinics
    if (req.user.role === 'admin') {
        if (!req.body.clinic_id) {
            return res.status(400).json({ error: 'Missing required field: clinic_id is required for admin users' })
        }
        clinic_id = req.body.clinic_id
    }
    // clinic_id from JWT for technician, but allow override for admin users to create clients for other clinics
    let newClient
    try {
        newClient = await clientModel.create({ name, dob, gender, race, notes, clinic_id }, req.dbClient)
    } catch (err) {
        console.log(err)
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid clinic_id format' })
        }
        if (err.code === '23503') { // foreign key violation
            if (err.constraint === 'clients_clinic_id_fkey')
                return res.status(400).json({ error: 'Invalid clinic_id' })
        }
        if (err.code === '22007' || err.code === '22008') { // invalid datetime format
            return res.status(400).json({ error: 'Invalid dob format, expected YYYY-MM-DD' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    }
    return res.status(201).json(newClient)
})

export default { listClients, getClientById, createClient }