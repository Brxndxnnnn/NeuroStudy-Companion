import sessionModel from '../models/session.model.js'
import sessionCommentaryModel from '../models/sessionCommentary.model.js'
import catchAsync from '../utils/catchAsync.js'
import { ConflictError, NotFoundError } from '../utils/AppError.js'
import { validateSessionCommentary } from '../validators/sessionCommentary.validators.js'

// RLS hides other clinics' sessions, so "not found" also covers "not yours".
const ensureSessionExists = async (session_id, dbClient) => {
    const results = await sessionModel.findById(session_id, dbClient)
    if (!results || results.length === 0)
        throw new NotFoundError('Session not found')
}

// ── GET /api/sessions/:session_id/commentaries ───────────────────────────────────
const listCommentaries = catchAsync(async (req, res) => {
    const { session_id } = req.validated
    await ensureSessionExists(session_id, req.dbClient)
    const commentaries = await sessionCommentaryModel.listBySessionId(session_id, req.dbClient)
    return res.json(commentaries)
})

// ── GET /api/sessions/:session_id/commentaries/:commentary_id ────────────────────
const getCommentaryById = catchAsync(async (req, res) => {
    const { session_id, commentary_id } = req.validated
    await ensureSessionExists(session_id, req.dbClient)
    const commentary = await sessionCommentaryModel.findById(commentary_id, req.dbClient)
    // A commentary ID from another session must not be readable through this session's URL.
    // Postgres returns UUIDs in lowercase; the path may use either case.
    if (!commentary || commentary.session_id !== session_id.toLowerCase())
        throw new NotFoundError('Session commentary not found')
    return res.json(commentary)
})

// ── GET /api/sessions/:session_id/commentaries/active ────────────────────────────
const getActiveCommentary = catchAsync(async (req, res) => {
    const { session_id } = req.validated
    await ensureSessionExists(session_id, req.dbClient)
    const commentary = await sessionCommentaryModel.findByStatus(session_id, 'active', req.dbClient)
    if (!commentary)
        throw new NotFoundError('Session has no published commentary')
    return res.json(commentary)
})

// ── GET /api/sessions/:session_id/commentaries/draft ─────────────────────────────
const getDraftCommentary = catchAsync(async (req, res) => {
    const { session_id } = req.validated
    await ensureSessionExists(session_id, req.dbClient)
    const draft = await sessionCommentaryModel.findByStatus(session_id, 'draft', req.dbClient)
    if (!draft)
        throw new NotFoundError('Session has no draft commentary')
    return res.json(draft)
})

// ── PUT /api/sessions/:session_id/commentaries/draft ─────────────────────────────
// Creates the draft or replaces it whole. Partial text is allowed; completeness is
// only enforced when publishing. The database refuses sessions that have not completed.
const saveDraftCommentary = catchAsync(async (req, res) => {
    const { session_id } = req.validated
    const commentary = validateSessionCommentary(req.body, { requireComplete: false })
    await ensureSessionExists(session_id, req.dbClient)
    const commentary_id = await sessionCommentaryModel.saveDraft(session_id, commentary, req.user.sub, req.dbClient)
    const draft = await sessionCommentaryModel.findById(commentary_id, req.dbClient)
    return res.json(draft)
})

// ── POST /api/sessions/:session_id/commentaries/draft/publish ────────────────────
const publishDraftCommentary = catchAsync(async (req, res) => {
    const { session_id } = req.validated
    await ensureSessionExists(session_id, req.dbClient)
    const draft = await sessionCommentaryModel.findByStatus(session_id, 'draft', req.dbClient)
    if (!draft)
        throw new NotFoundError('Session has no draft commentary')

    // Checked here for a readable 400 listing every missing section; the database
    // CHECK constraint enforces the same rule if the draft changes meanwhile.
    validateSessionCommentary(draft, { requireComplete: true })

    const commentary_id = await sessionCommentaryModel.publish(draft.commentary_id, req.user.sub, req.dbClient)
    if (!commentary_id)
        throw new ConflictError('Draft commentary was published or discarded by another request')

    const published = await sessionCommentaryModel.findById(commentary_id, req.dbClient)
    return res.json(published)
})

// ── DELETE /api/sessions/:session_id/commentaries/draft ──────────────────────────
const deleteDraftCommentary = catchAsync(async (req, res) => {
    const { session_id } = req.validated
    await ensureSessionExists(session_id, req.dbClient)
    const commentary_id = await sessionCommentaryModel.deleteDraft(session_id, req.dbClient)
    if (!commentary_id)
        throw new NotFoundError('Session has no draft commentary')
    return res.status(204).send()
})

export default {
    listCommentaries,
    getCommentaryById,
    getActiveCommentary,
    getDraftCommentary,
    saveDraftCommentary,
    publishDraftCommentary,
    deleteDraftCommentary
}
