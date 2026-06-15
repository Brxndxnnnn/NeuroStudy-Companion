import sessionModel from '../models/session.model.js'
import catchAsync  from '../utils/catchAsync.js'

// ── GET /api/sessions ──────────────────────────────────────────────────────────
const listSessions = catchAsync(async (req, res) => {
    const sessions = await sessionModel.findAll(req.dbClient)
    return res.json(sessions)
})

// ── PATCH /api/sessions/pair ────────────────────────────────────────────────────
const pairSessions = catchAsync(async (req, res) => {
    const { pairing_code, client_id } = req.body

    if (!pairing_code || !client_id) {
        return res.status(400).json({ error: 'pairing_code and client_id are required' })
    }

    // req.dbClient is passed to maintain the connection context, 
    // but the SECURITY DEFINER function handles the RLS bypass internally.
    const session = await sessionModel.pairSessions(
        pairing_code.trim().toUpperCase(), // Normalize input
        client_id, 
        req.user.sub,       // conducted_by (from JWT)
        req.user.clinic_id, // clinic_id (from JWT)
        req.dbClient
    )

    if (!session) {
        return res.status(404).json({ error: 'Invalid pairing code or session already claimed.' })
    }

    return res.status(200).json(session)
})


export default { listSessions, pairSessions }