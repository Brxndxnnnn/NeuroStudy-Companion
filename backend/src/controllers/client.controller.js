import clientModel from '../models/client.model.js'
import catchAsync  from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

// ── GET /api/clients ─────────────────────────────────────────────────────────────
const listClients = catchAsync(async (req, res) => {
    const clients = await clientModel.findAll(req.dbClient)
    return res.json(clients)
})

// ── GET /api/clients/:client_id ────────────────────────────────────────────────
const getClientById = catchAsync(async (req, res) => {
    const { client_id } = req.params
    if (!client_id)
        throw new BadRequestError('Missing required field: client_id is required')
    const results = await clientModel.findById(client_id, req.dbClient)
    if (!results || results.length === 0)
        throw new NotFoundError('Client not found')
    return res.json(results[0])
})

// ── POST /api/clients ─────────────────────────────────────────────────────────
const createClient = catchAsync(async (req, res) => {
    const { name, dob, gender, race, notes } = req.body

    if (!name || !dob || !gender || !race)
        throw new BadRequestError('Missing required fields: name, dob, gender, and race are required')

    let clinic_id = req.user.clinic_id // from JWT for technician, but allow override for admin users to create clients for other clinics
    if (req.user.role === 'admin') {
        if (!req.body.clinic_id)
            throw new BadRequestError('Missing required field: clinic_id is required for admin users')
        clinic_id = req.body.clinic_id
    }
    // clinic_id from JWT for technician, but allow override for admin users to create clients for other clinics
    const newClient = await clientModel.create({ name, dob, gender, race, notes, clinic_id }, req.dbClient)
    return res.status(201).json(newClient)
})

export default { listClients, getClientById, createClient }