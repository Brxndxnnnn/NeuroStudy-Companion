import eventModel from '../models/event.model.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

// ── POST /api/events ─────────────────────────────────────────────────────────────
const createEvent = catchAsync(async (req, res) => {
    const { session_id, image_id, question_id, } = req.body
    if (!session_id)
        throw new BadRequestError('Missing required fields: session_id and image_id are required')
    if (!image_id && !question_id)
        throw new BadRequestError('Missing required fields: image_id or question_id is required')
    // Only one of image_id or question_id should be provided
    if (image_id && question_id)
        throw new BadRequestError('Only one of image_id or question_id should be provided')

    const event = await eventModel.create({ session_id, image_id, question_id, clinic_id: req.user.clinic_id }, req.dbClient)
    return res.status(201).json(event)
})

// ── PATCH /api/events/:event_id/hide ─────────────────────────────────────────────
const updateEvent = catchAsync(async (req, res) => {
    const { event_id } = req.params
    if (!event_id)
        throw new BadRequestError('Missing required field: event_id is required')
    const event = await eventModel.setHiddenAt(event_id, req.dbClient)

    if (!event || event.length === 0)
        throw new NotFoundError('Event not found')

    return res.json(event)
})

export default { createEvent, updateEvent }