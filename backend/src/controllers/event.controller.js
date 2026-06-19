import eventModel from '../models/event.model.js'
import catchAsync from '../utils/catchAsync.js'

// ── POST /api/events ─────────────────────────────────────────────────────────────
const createEvent = catchAsync(async (req, res) => {
    const { session_id, image_id } = req.body

    if (!session_id || !image_id)
        return res.status(400).json({ error: 'Missing required fields: session_id and image_id are required' })

    const event = await eventModel.create({ session_id, image_id, clinic_id: req.user.clinic_id }, req.dbClient).then(event => {
        return res.status(201).json(event)
    }).catch(err => {
        if (err.code === '22P02') { // invalid input syntax for uuid
            if (err.position === '8') // session_id
                return res.status(400).json({ error: 'Invalid session_id format' })
            if (err.position === '20') // image_id
                return res.status(400).json({ error: 'Invalid image_id format' })
        }
        if (err.code === '23503') { // foreign key violation
            if (err.constraint === 'events_session_id_fkey')
                return res.status(400).json({ error: 'Invalid session_id' })
            if (err.constraint === 'events_image_id_fkey')
                return res.status(400).json({ error: 'Invalid image_id' })
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