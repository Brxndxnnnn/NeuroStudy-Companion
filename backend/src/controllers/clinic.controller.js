import clinicModel from '../models/clinic.model.js'
import catchAsync  from '../utils/catchAsync.js'

// ── POST /api/clinics ─────────────────────────────────────────────────────────
const createClinic = catchAsync(async (req, res) => {
    const { name, address } = req.body

    if (!name) return res.status(400).json({ error: 'name is required' })

    const clinic = await clinicModel.create({ name, address }, req.dbClient)
    return res.status(201).json(clinic)
})

// ── GET /api/clinics ──────────────────────────────────────────────────────────
const listClinics = catchAsync(async (req, res) => {
    const clinics = await clinicModel.findAll(req.dbClient)
    return res.json(clinics)
})

// ── GET /api/clinics/:id ──────────────────────────────────────────────────────
const getClinic = catchAsync(async (req, res) => {
    const clinic = await clinicModel.findById(req.params.id, req.dbClient)
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' })
    return res.json(clinic)
})

// ── PATCH /api/clinics/:id ────────────────────────────────────────────────────
const updateClinic = catchAsync(async (req, res) => {
    const { name, address } = req.body

    const clinic = await clinicModel.update(req.params.id, { name, address }, req.dbClient)

    if (clinic === null)      return res.status(400).json({ error: 'Nothing to update' })
    if (clinic === undefined) return res.status(404).json({ error: 'Clinic not found' })

    return res.json(clinic)
})

export default { createClinic, listClinics, getClinic, updateClinic }