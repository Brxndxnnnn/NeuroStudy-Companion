import eventModel from '../models/event.model.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

const normalizeOccurredAt=value => {
    if (value===undefined || value===null)
        return null

    if (typeof value!=='string')
        throw new BadRequestError('occurred_at must be an ISO 8601 timestamp')

    const parsed=new Date(value)

    if (Number.isNaN(parsed.getTime()))
        throw new BadRequestError('occurred_at must be an ISO 8601 timestamp')

    return parsed.toISOString()
}

// Protocol phase markers (countdowns + baseline eyes-open/eyes-closed periods) — kept in
// sync with db/migrations/016_session_phase_markers.sql's chk_events_phase.
const VALID_PHASES = [
    'countdown_pre', 'baseline1_closed', 'countdown_b1', 'baseline1_open', 'countdown_images',
    'countdown_post', 'baseline2_closed', 'countdown_b2', 'baseline2_open',
]

// ── POST /api/events ─────────────────────────────────────────────────────────────
const createEvent = catchAsync(async (req, res) => {
    const { session_id, image_id, question_id, phase, occurred_at } = req.body
    if (!session_id)
        throw new BadRequestError('Missing required fields: session_id is required')
    const provided = [image_id, question_id, phase].filter(Boolean)
    if (provided.length === 0)
        throw new BadRequestError('Missing required fields: one of image_id, question_id, or phase is required')
    if (provided.length > 1)
        throw new BadRequestError('Only one of image_id, question_id, or phase should be provided')
    if (phase && !VALID_PHASES.includes(phase))
        throw new BadRequestError(`Invalid phase value. Must be one of: ${VALID_PHASES.join(', ')}`)
    if (!occurred_at)
        throw new BadRequestError('Missing required field: occurred_at is required')

    const event = await eventModel.create({ session_id, image_id, question_id, phase, clinic_id: req.user.clinic_id, occurred_at: normalizeOccurredAt(occurred_at) }, req.dbClient)
    return res.status(201).json(event)
})

// ── PATCH /api/events/:event_id/hide ─────────────────────────────────────────────
const updateEvent = catchAsync(async (req, res) => {
    const { event_id } = req.params
    if (!event_id)
        throw new BadRequestError('Missing required field: event_id is required')
    const { occurred_at } = req.body
    if (!occurred_at)
        throw new BadRequestError('Missing required field: occurred_at is required')

    const event = await eventModel.setHiddenAt(
        event_id,
        req.user.clinic_id,
        normalizeOccurredAt(occurred_at),
        req.dbClient
    )

    if (!event || event.length === 0)
        throw new NotFoundError('Event not found')

    return res.json(event)
})

// ── GET /api/time ─────────────────────────────────────────────────────────────
const getServerTime = catchAsync(async (req, res) => {
    const serverTime = await eventModel.getServerTime(req.dbClient)
    res.set('Cache-Control', 'no-store')
    return res.json({ server_time: serverTime })
})

export default { createEvent, updateEvent, getServerTime }
