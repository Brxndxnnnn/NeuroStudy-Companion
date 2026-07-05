import sessionModel from '../models/session.model.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/appError.js'

// ── GET /api/sessions ──────────────────────────────────────────────────────────
const listSessions = catchAsync(async (req, res) => {
    const sessions = await sessionModel.findAll(req.dbClient)
    return res.json(sessions)
})

// ── GET /api/sessions/:session_id ─────────────────────────────────────────────
const getSessionById = catchAsync(async (req, res) => {
    console.log(`Fetching session by ID: ${req.params.session_id}`)
    const { session_id } = req.params
    if (!session_id)
        throw new BadRequestError('Missing required field: session_id is required')
    const results = await sessionModel.findById(session_id, req.dbClient)
    if (!results || results.length === 0)
        throw new NotFoundError('Session not found')

    return res.json(results[0])
})

// ── PATCH /api/sessions/pair ────────────────────────────────────────────────────
const pairSessions = catchAsync(async (req, res) => {
    const { pairing_code, client_id } = req.body

    if (!pairing_code || !client_id)
        throw new BadRequestError('pairing_code and client_id are required')

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
        if (err.message.includes('Invalid pairing code or session already claimed'))
            throw new NotFoundError('Invalid pairing code or session already claimed.')
        throw err
    }

    if (!session)
        throw new NotFoundError('Invalid pairing code or session already claimed.')

    return res.status(200).json(session)
})

// ── PATCH /api/sessions/:session_id/start ────────────────────────────────────────────
const startSession = catchAsync(async (req, res) => {
    const { session_id } = req.params;
    const session = await sessionModel.startSession(session_id, req.dbClient);
    if (!session)
        throw new NotFoundError('Session not found');

    return res.json(session);
});

// ── PATCH /api/sessions/:session_id/end ────────────────────────────────────────────
const endSession = catchAsync(async (req, res) => {
    const { session_id } = req.params;
    const session = await sessionModel.endSession(session_id, req.dbClient);
    if (!session)
        throw new NotFoundError('Session not found');

    let backfillWarning = null;
    try {
        await sessionModel.backfillSessionResults(session_id, req.dbClient);
    } catch (err) {
        // Log the error for the backend team to investigate
        console.error(`[Backfill Error] Session ${session_id}:`, err.message);
        backfillWarning = 'Session ended successfully, but data backfill failed. Results may be incomplete.';
    }

    const response = { session };
    if (backfillWarning)
        response.warning = backfillWarning;

    return res.json(response);
})

// ── GET /api/sessions/:session_id/results ────────────────────────────────────────────
const getSessionResult = catchAsync(async (req, res) => {
    console.log(`Fetching session results for session_id: ${req.params.session_id}`)
    const { session_id } = req.params
    const results = await sessionModel.getSessionResult(session_id, req.dbClient)

    if (!results || results.length === 0)
        throw new NotFoundError('No results found for the given session_id')
    return res.json(results)
})
// ── GET /api/sessions/:session_id/results/raw ────────────────────────────────────────────
const getSessionEEGResults = catchAsync(async (req, res) => {
    const { session_id } = req.params
    if (!session_id)
        throw new BadRequestError('Missing required field: session_id is required')
    const sessions = await sessionModel.findById(session_id, req.dbClient)
    if (!sessions || sessions.length === 0)
        throw new NotFoundError('Session not found')
    const session = sessions[0]

    const startSeconds = parseFloat(req.query.start_seconds)
    const endSeconds = parseFloat(req.query.end_seconds)
    if (isNaN(startSeconds) || isNaN(endSeconds) || startSeconds < 0 || endSeconds < 0 || endSeconds <= startSeconds)
        throw new BadRequestError('Invalid start_seconds or end_seconds values')
    const rawOrFiltered = req.path.includes('/raw') ? 'raw' : 'filtered'
    const fromTs = new Date(new Date(session.start_time).getTime() + startSeconds * 1000)
    const toTs = new Date(new Date(session.start_time).getTime() + endSeconds * 1000)
    
    const results = await sessionModel.getSessionEEGResults({
        session_id, sample_rate: session.sample_rate, start_time: session.start_time, end_time: session.end_time
    },
        fromTs, toTs, rawOrFiltered, req.dbClient)
    return res.json(results)
})
export default { listSessions, getSessionById, pairSessions, startSession, endSession, getSessionResult, getSessionEEGResults }