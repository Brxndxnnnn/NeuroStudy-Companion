import eventModel from '../models/event.model.js'
import catchAsync from '../utils/catchAsync.js'

// ── POST /api/events ─────────────────────────────────────────────────────────────
const createEvent = catchAsync(async (req, res) => {
    const { session_id, image_id, question_id, } = req.body
    if (!session_id)
        return res.status(400).json({ error: 'Missing required fields: session_id and image_id are required' })
    if (!image_id && !question_id)
        return res.status(400).json({ error: 'Missing required fields: image_id or question_id is required' })
    // Only one of image_id or question_id should be provided
    if (image_id && question_id)
        return res.status(400).json({ error: 'Only one of image_id or question_id should be provided' })

    const event = await eventModel.create({ session_id, image_id, question_id, clinic_id: req.user.clinic_id }, req.dbClient).then(event => {
        return res.status(201).json(event)
    }).catch(err => {
        if (err.code === '22P02') { // invalid input syntax for uuid
            if (err.where.includes('$1')) // session_id
                return res.status(400).json({ error: 'Invalid session_id format' })
            if (err.where.includes('$2')) // image_id or question_id
                return res.status(400).json({ error: 'Invalid image_id or question_id format' })
        }
        if (err.code === '23503') { // foreign key violation
            if (err.constraint === 'events_session_id_fkey')
                return res.status(400).json({ error: 'Invalid session_id' })
            if (err.constraint === 'events_image_id_fkey')
                return res.status(400).json({ error: 'Invalid image_id' })
            if (err.constraint === 'events_question_id_fkey')
                return res.status(400).json({ error: 'Invalid question_id' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    })
})

// ── PATCH /api/events/:event_id/hide ─────────────────────────────────────────────
const updateEvent = catchAsync(async (req, res) => {
    const { event_id } = req.params
    const event = await eventModel.setHiddenAt(event_id, req.dbClient).then(event => {
        if (!event)
            return res.status(404).json({ error: 'Event not found' })
        return res.json(event)
    }).catch(err => {
        if (err.code === '22P02') { // invalid input syntax for uuid
            if (err.position === '8') // event_id
                return res.status(400).json({ error: 'Invalid event_id format' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    })
})

export default { createEvent, updateEvent }