import clinicModel from '../models/clinic.model.js'
import catchAsync  from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

// ── POST /api/clinics ─────────────────────────────────────────────────────────
const createClinic = catchAsync(async (req, res) => {
    const { name, address } = req.body
    if (!name) throw new BadRequestError('name is required')
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
    const { id } = req.params
    if (!id)
        throw new BadRequestError('Missing required field: id is required')
    const clinic = await clinicModel.findById(id, req.dbClient)
    if (!clinic) throw new NotFoundError('Clinic not found')
    return res.json(clinic)
})

// ── PATCH /api/clinics/:id ────────────────────────────────────────────────────
const updateClinic = catchAsync(async (req, res) => {
    const { name, address } = req.body
    const { id } = req.params

    if (!id)
        throw new BadRequestError('Missing required field: id is required')
    if (!name && !address)
        throw new BadRequestError('At least one of name or address is required')
    const clinic = await clinicModel.update(id, { name, address }, req.dbClient)

    if (clinic === null)      throw new BadRequestError('Nothing to update')
    if (clinic === undefined) throw new NotFoundError('Clinic not found')

    return res.json(clinic)
})

export default { createClinic, listClinics, getClinic, updateClinic }