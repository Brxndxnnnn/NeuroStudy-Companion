import sessionModel from '../models/session.model.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError, PermissionDeniedError, AppError } from '../utils/AppError.js'
import fs from 'fs'

// ── GET /api/sessions ──────────────────────────────────────────────────────────
const listSessions = catchAsync(async (req, res) => {
    const clinic_id = ['admin', 'superadmin'].includes(req.user.role) ? req.query.clinic_id : req.user.clinic_id // from JWT for technician, undefined for admins
    const { sync_status, start_date, end_date, search } = req.query
    const page = Number(req.query.page ?? 1)
    const page_size = Number(req.query.page_size ?? 20)
    const validStatuses = ['unclaimed', 'claimed', 'recording', 'completed'];
    if (sync_status && !validStatuses.includes(sync_status))
        throw new BadRequestError(`Invalid sync_status value. Must be one of: ${validStatuses.join(', ')}`)
    if (start_date && isNaN(Date.parse(start_date)))
        throw new BadRequestError('Invalid start_date value. Must be a valid date string.')
    if (end_date && isNaN(Date.parse(end_date)))
        throw new BadRequestError('Invalid end_date value. Must be a valid date string.')
    if (!Number.isInteger(page) || page < 1)
        throw new BadRequestError('Invalid page value. It must be a positive integer.')
    if (!Number.isInteger(page_size) || page_size < 1 || page_size > 100)
        throw new BadRequestError('Invalid page_size value. It must be an integer between 1 and 100.')

    const result = await sessionModel.findAll({
        clinic_id,
        sync_status,
        start_date,
        end_date,
        search: search?.trim() || undefined,
        page,
        page_size
    }, req.dbClient)
    return res.json(result)
})

// ── GET /api/sessions/:session_id ─────────────────────────────────────────────
const getSessionById = catchAsync(async (req, res) => {
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

// ── PATCH /api/sessions/:session_id/end ────────────────────────────────────────────
const endSession = catchAsync(async (req, res) => {
    const { session_id } = req.params;
    const session = await sessionModel.endSession(session_id, req.dbClient);
    if (!session)
        throw new NotFoundError('Session not found');

    await req.dbClient.query('COMMIT'); // Commit the transaction after ending the session
    
    let backfillWarning = null;
    try {
        await sessionModel.backfillSessionResults(session_id);
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

// -- DELETE /api/sessions/:session_id ------------------------------------------------
// Session foreign keys are deliberately configured with ON DELETE CASCADE, so deleting
// the session is sufficient to remove its dependent session data atomically.
const deleteSession = catchAsync(async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin')
        throw new PermissionDeniedError('Only administrators can delete sessions.')

    const { session_id } = req.params
    if (!session_id)
        throw new BadRequestError('Missing required field: session_id is required')

    const deletedSession = await sessionModel.deleteById(session_id, req.dbClient)
    if (!deletedSession)
        throw new NotFoundError('Session not found')

    return res.status(200).json({ message: 'Session deleted successfully.', session_id: deletedSession.session_id })
})

// ── GET /api/sessions/:session_id/results ────────────────────────────────────────────
const getSessionResult = catchAsync(async (req, res) => {
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

    if (req.query.start_seconds && isNaN(req.query.start_seconds))
        throw new BadRequestError('Invalid start_seconds value')
    if (req.query.end_seconds && isNaN(req.query.end_seconds))
        throw new BadRequestError('Invalid end_seconds value')
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

    
    // res.setHeader('Content-Type', 'application/json');
    // const stream = fs.createReadStream(results.samples_file_path);
    // stream.on('error', (err) => {
    //     console.error('Error reading EEG results file:', err);
    //     throw new AppError('Failed to read EEG results file', 500);
    // });
    // stream.on('end', () => {
    //     fs.unlink(results.samples_file_path, (err) => {
    //         if (err) console.error('Error deleting temporary EEG results file:', err);
    //     });
    // });
    // stream.pipe(res);
    return res.json(results)
})

// ── GET /api/sessions/:session_id/results/bandpower ────────────────────────────────────────────
const getSessionBandPowerResults = catchAsync(async (req, res) => {
    const { session_id } = req.params
    if (!session_id)
        throw new BadRequestError('Missing required field: session_id is required')
    const sessions = await sessionModel.findById(session_id, req.dbClient)
    if (!sessions || sessions.length === 0)
        throw new NotFoundError('Session not found')
    const session = sessions[0]

    // Validate and compute start and end timestamps based on query parameters
    if (req.query.start_seconds && isNaN(req.query.start_seconds))
        throw new BadRequestError('Invalid start_seconds value')
    if (req.query.end_seconds && isNaN(req.query.end_seconds))
        throw new BadRequestError('Invalid end_seconds value')
    const startSeconds = parseFloat(req.query.start_seconds) || 0
    const endSeconds = parseFloat(req.query.end_seconds) || (new Date(session.end_time).getTime() - new Date(session.start_time).getTime()) / 1000
    // Default to the full session duration if not provided
    if (isNaN(startSeconds) || isNaN(endSeconds) || startSeconds < 0 || endSeconds < 0 || endSeconds <= startSeconds)
        throw new BadRequestError('Invalid start_seconds or end_seconds values')
    const fromTs = new Date(new Date(session.start_time).getTime() + startSeconds * 1000)
    const toTs = new Date(new Date(session.start_time).getTime() + endSeconds * 1000)

    const results = await sessionModel.getSessionBandPowerResults({
        session_id, start_time: session.start_time, end_time: session.end_time
    },
        fromTs, toTs, req.dbClient)
    return res.json(results)
})

// ── GET /api/sessions/:session_id/results/elliptic_band_stats ────────────────────────────────────────────
const getSessionEllipticBandStats = catchAsync(async (req, res) => {
    const { session_id } = req.params
    if (!session_id)
        throw new BadRequestError('Missing required field: session_id is required')
    const results = await sessionModel.getEllipticBandStats(session_id, req.dbClient)
    return res.json(results)
})

// ── GET /api/sessions/:session_id/results/fft_bandpower ────────────────────────────────────────────
// Our FFT-computed band powers (fft_band_powers) — the source of the "Frequency bands"
// chart, replacing the SDK's band_powers. Already downsampled, so the whole session is
// returned without start/end bounds.
const getSessionFftBandPowerResults = catchAsync(async (req, res) => {
    const { session_id } = req.params
    if (!session_id)
        throw new BadRequestError('Missing required field: session_id is required')
    const results = await sessionModel.getSessionFftBandPowerResults(session_id, req.dbClient)
    return res.json(results)
})

export default { listSessions, getSessionById, pairSessions, endSession, deleteSession, getSessionResult, getSessionEEGResults, getSessionBandPowerResults, getSessionEllipticBandStats, getSessionFftBandPowerResults }
