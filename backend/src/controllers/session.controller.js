import sessionModel from '../models/session.model.js'
import catchAsync  from '../utils/catchAsync.js'

// ── GET /api/sessions ──────────────────────────────────────────────────────────
const listSessions = catchAsync(async (req, res) => {
    const sessions = await sessionModel.findAll(req.dbClient)
    return res.json(sessions)
})

// ── GET /api/sessions/:session_id ─────────────────────────────────────────────
const getSessionById = catchAsync(async (req, res) => {
    const { session_id } = req.params
    let results

    try {
        results = await sessionModel.findById(session_id, req.dbClient)
    } catch (err) {
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid session_id format' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    }

    if (!results || results.length === 0) {
        return res.status(404).json({ error: 'Session not found' })
    }
    
    return res.json(results[0])
})

// ── PATCH /api/sessions/pair ────────────────────────────────────────────────────
const pairSessions = catchAsync(async (req, res) => {
    const { pairing_code, client_id } = req.body

    if (!pairing_code || !client_id) {
        return res.status(400).json({ error: 'pairing_code and client_id are required' })
    }

    let session
    // req.dbClient is passed to maintain the connection context, 
    // but the SECURITY DEFINER function handles the RLS bypass internally.
    try {
        session = await sessionModel.pairSessions(
            pairing_code.trim().toUpperCase(), // Normalize input
            client_id, 
            req.user.sub,       // conducted_by (from JWT)
            req.user.clinic_id, // clinic_id (from JWT)
            req.dbClient
        )
    } catch (err) {
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid client_id format' })
        }
        if (err.message.includes('Invalid pairing code or session already claimed')) {
            return res.status(404).json({ error: 'Invalid pairing code or session already claimed.' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    }

    return res.status(200).json(session)
})

// ── PATCH /api/sessions/:session_id/start ────────────────────────────────────────────
const startSession = catchAsync(async (req, res) => {
    const { session_id } = req.params;
    let session;

    try {
        session = await sessionModel.startSession(session_id, req.dbClient);
    } catch (err) {
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid session_id format' });
        }
        return res.status(500).json({ error: 'Internal server error' });
    }

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    return res.json(session);
});

// ── PATCH /api/sessions/:session_id/end ────────────────────────────────────────────
const endSession = catchAsync(async (req, res) => {
    const { session_id } = req.params;
    let session;

    try {
        session = await sessionModel.endSession(session_id, req.dbClient);
    } catch (err) {
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid session_id format' });
        }
        return res.status(500).json({ error: 'Internal server error' });
    }

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    return res.json(session);
})

// ── GET /api/sessions/:session_id/results ────────────────────────────────────────────
const getSessionResult = catchAsync(async (req, res) => {
    const { session_id } = req.params
    let results
    try {
        results = await sessionModel.findById(session_id, req.dbClient)
    } catch (err) {
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid session_id format' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    }

    if (!results || results.length === 0) {
        return res.status(404).json({ error: 'No results found for the given session_id' })
    }
    return res.json(results)
})
export default { listSessions, getSessionById, pairSessions, startSession, endSession, getSessionResult}