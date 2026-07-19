import clinicModel from '../models/clinic.model.js'
import catchAsync  from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'
import { getClinicScope } from '../utils/helper.js'
import { createHmac, randomBytes } from 'crypto'

const ACTIVATION_CODE_PATTERN=/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/

const getActivationPepper=() => {
    const pepper=process.env.ACTIVATION_CODE_PEPPER

    if (!pepper)
        throw new Error('ACTIVATION_CODE_PEPPER is not configured')

    return pepper
}

const hashActivationCode=activationCode =>
    createHmac('sha256',getActivationPepper())
        .update(activationCode)
        .digest('hex')

const generateActivationCode=() => {
    const raw=randomBytes(8)
        .toString('hex')
        .toUpperCase()

    return raw.match(/.{1,4}/g).join('-')
}

const generateDatabasePassword=() =>
    randomBytes(32).toString('base64url')

const generateDatabaseRole=clinicId => {
    const clinicPart=clinicId.replaceAll('-','').slice(0,12)
    const randomPart=randomBytes(5).toString('hex')

    return `clinic_${clinicPart}_${randomPart}`.slice(0,63)
}

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

// POST /api/clinics/:id/database-access
const createClinicDatabaseAccess=catchAsync(async(req,res) => {
    const {id}=req.params
    const requestedExpiryHours=Number(req.body?.expires_in_hours ?? 24)

    if (!id)
        throw new BadRequestError('Missing required field: id is required')

    if (
        !Number.isInteger(requestedExpiryHours)
        || requestedExpiryHours<1
        || requestedExpiryHours>168
    )
        throw new BadRequestError(
            'expires_in_hours must be an integer between 1 and 168'
        )

    const clinic=await clinicModel.findById(id,req.dbClient)

    if (!clinic)
        throw new NotFoundError('Clinic not found')

    const activationCode=generateActivationCode()
    const activationCodeHash=hashActivationCode(activationCode)
    const databaseRole=generateDatabaseRole(id)
    const expiresAt=new Date(
        Date.now()+requestedExpiryHours*60*60*1000
    )

    const access=await clinicModel.createDatabaseAccess({
        clinicId:id,
        databaseRole,
        activationCodeHash,
        expiresAt
    },req.dbClient)

    res.set('Cache-Control','no-store')

    return res.status(201).json({
        status:'success',
        data:{
            activation_id:access.activation_id,
            clinic_id:access.clinic_id,
            database_role:access.database_role,
            activation_code:activationCode,
            expires_at:access.expires_at
        }
    })
})

// POST /api/clinics/activate
const activateClinicDatabaseAccess=catchAsync(async(req,res) => {
    const activationCode=String(
        req.body?.activation_code ?? ''
    )
        .trim()
        .toUpperCase()

    if (!ACTIVATION_CODE_PATTERN.test(activationCode))
        throw new BadRequestError('Invalid or unavailable activation code')

    const activationCodeHash=hashActivationCode(activationCode)
    const databasePassword=generateDatabasePassword()

    const activated=await clinicModel.redeemDatabaseAccess({
        activationCodeHash,
        databasePassword
    },req.dbClient)

    if (!activated)
        throw new BadRequestError('Invalid or unavailable activation code')

    res.set('Cache-Control','no-store')
    res.set('Pragma','no-cache')

    return res.json({
        status:'success',
        data:{
            activation_id:activated.activation_id,
            clinic_id:activated.clinic_id,
            database:{
                host:process.env.PUBLIC_DB_HOST
                    ?? 'clinics.axonview.sg',
                port:Number(process.env.PUBLIC_DB_PORT ?? 5432),
                name:process.env.PUBLIC_DB_NAME
                    ?? 'neurostudy',
                username:activated.database_role,
                password:databasePassword,
                ssl_mode:'VerifyFull'
            }
        }
    })
})

export default { createClinic, listClinics, getClinic, updateClinic, getClinicStimulusSets, getClinicStimulusSetById, updateClinicStimulusSet, createClinicDatabaseAccess, activateClinicDatabaseAccess }