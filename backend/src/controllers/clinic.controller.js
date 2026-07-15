import clinicModel from '../models/clinic.model.js'
import catchAsync  from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'
import { getClinicScope } from '../utils/helper.js'

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

// GET /api/clinics/stimulus-sets
const getClinicStimulusSets = catchAsync(async (req, res) => {
    const scope = getClinicScope(req)
    
    const stimulusSets = await clinicModel.getClinicStimulusSets(
        scope,
        req.dbClient
    )

    return res.json({
        status: 'success',
        results: stimulusSets.length,
        data: stimulusSets
    })
})

// GET /api/clinics/stimulus-sets/:stimulus_set_id
const getClinicStimulusSetById = catchAsync(async (req, res) => {
    const scope = getClinicScope(req)

    const stimulusSet = await clinicModel.getClinicStimulusSetById(
        req.params.stimulus_set_id,
        scope,
        req.dbClient
    )

    if (!stimulusSet)
        throw new NotFoundError('Stimulus set not found.')

    return res.json({
        status: 'success',
        data: stimulusSet
    })
})

// PUT /api/clinics/stimulus-sets/:stimulus_set_id
const updateClinicStimulusSet = catchAsync(async (req, res) => {
    const {name, status = 'draft', images} = req.body
    const scope = getClinicScope(req, 'body')

    if (name !== undefined && (typeof name !== 'string' || !name.trim()))
        throw new BadRequestError('name must be a non-empty string.')

    if (!['draft', 'active'].includes(status))
        throw new BadRequestError('status must be either draft or active.')

    if (!Array.isArray(images) || images.length !== 24)
        throw new BadRequestError(`images must contain exactly 24 items. Currently contains ${images.length} items.`)

    const imageIds = images.map(image =>
        typeof image === 'string' ? image : image?.image_id
    )

    if (imageIds.some(imageId => typeof imageId !== 'string' || !imageId.trim()))
        throw new BadRequestError('Every image must contain a valid image_id.')

    if (new Set(imageIds).size !== 24)
        throw new BadRequestError('The 24 selected images must be unique.')

    const result = await clinicModel.updateClinicStimulusSet(
        req.params.stimulus_set_id,
        {
            name,
            status,
            imageIds
        },
        {
            ...scope,
            userId: req.user.sub
        },
        req.dbClient
    )

    if (!result)
        throw new NotFoundError('Stimulus set not found.')

    return res.json({
        status: 'success',
        data: result.stimulusSet,
        meta: {
            created_new_version: result.createdNewVersion,
            source_stimulus_set_id: result.sourceStimulusSetId
        }
    })
})

export default { createClinic, listClinics, getClinic, updateClinic, getClinicStimulusSets, getClinicStimulusSetById, updateClinicStimulusSet }