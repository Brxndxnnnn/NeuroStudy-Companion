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

// ── POST /api/events ─────────────────────────────────────────────────────────────
const createEvent = catchAsync(async (req, res) => {
    const { session_id, image_id, question_id, occurred_at } = req.body
    if (!session_id)
        throw new BadRequestError('Missing required fields: session_id is required')
    if (!image_id && !question_id)
        throw new BadRequestError('Missing required fields: image_id or question_id is required')
    // Only one of image_id or question_id should be provided
    if (image_id && question_id)
        throw new BadRequestError('Only one of image_id or question_id should be provided')
    if (!occurred_at)
        throw new BadRequestError('Missing required field: occurred_at is required')

    const event = await eventModel.create({ session_id, image_id, question_id, clinic_id: req.user.clinic_id, occurred_at: normalizeOccurredAt(occurred_at) }, req.dbClient)
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
