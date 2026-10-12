import clientModel from '../models/client.model.js'
import clientHistoryModel from '../models/clientHistory.model.js'
import catchAsync from '../utils/catchAsync.js'
import { ConflictError, NotFoundError } from '../utils/AppError.js'
import { validateClientHistory } from '../validators/clientHistory.validators.js'

// RLS hides other clinics' clients, so "not found" also covers "not yours".
const ensureClientExists = async (client_id, dbClient) => {
    const results = await clientModel.findById(client_id, dbClient)
    if (!results || results.length === 0)
        throw new NotFoundError('Client not found')
}

// ── GET /api/clients/:client_id/histories/active ─────────────────────────────────
const getActiveHistory = catchAsync(async (req, res) => {
    const { client_id } = req.validated
    await ensureClientExists(client_id, req.dbClient)
    const history = await clientHistoryModel.findByStatus(client_id, 'active', req.dbClient)
    if (!history)
        throw new NotFoundError('Client has no published history')
    return res.json(history)
})

// ── GET /api/clients/:client_id/histories/draft ──────────────────────────────────
const getDraftHistory = catchAsync(async (req, res) => {
    const { client_id } = req.validated
    await ensureClientExists(client_id, req.dbClient)
    const draft = await clientHistoryModel.findByStatus(client_id, 'draft', req.dbClient)
    if (!draft)
        throw new NotFoundError('Client has no draft history')
    return res.json(draft)
})

// ── PUT /api/clients/:client_id/histories/draft ──────────────────────────────────
// Creates the draft or replaces it whole (fields and answers). Partial data is
// allowed; completeness is only enforced when publishing.
const saveDraftHistory = catchAsync(async (req, res) => {
    const { client_id } = req.validated
    const history = validateClientHistory(req.body, { requireComplete: false })
    await ensureClientExists(client_id, req.dbClient)
    const history_id = await clientHistoryModel.saveDraft(client_id, history, req.user.sub, req.dbClient)
    const draft = await clientHistoryModel.findById(history_id, req.dbClient)
    return res.json(draft)
})

// ── POST /api/clients/:client_id/histories/draft/publish ─────────────────────────
const publishDraftHistory = catchAsync(async (req, res) => {
    const { client_id } = req.validated
    await ensureClientExists(client_id, req.dbClient)
    const draft = await clientHistoryModel.findByStatus(client_id, 'draft', req.dbClient)
    if (!draft)
        throw new NotFoundError('Client has no draft history')

    // Checked here for a readable 400 listing every missing item; the database
    // trigger and CHECK constraint enforce the same rule if the draft changes meanwhile.
    validateClientHistory(draft, { requireComplete: true })

    const history_id = await clientHistoryModel.publish(draft.history_id, req.user.sub, req.dbClient)
    if (!history_id)
        throw new ConflictError('Draft history was published or discarded by another request')

    const published = await clientHistoryModel.findById(history_id, req.dbClient)
    return res.json(published)
})

// ── DELETE /api/clients/:client_id/histories/draft ───────────────────────────────
const deleteDraftHistory = catchAsync(async (req, res) => {
    const { client_id } = req.validated
    await ensureClientExists(client_id, req.dbClient)
    const history_id = await clientHistoryModel.deleteDraft(client_id, req.dbClient)
    if (!history_id)
        throw new NotFoundError('Client has no draft history')
    return res.status(204).send()
})

export default {
    getActiveHistory,
    getDraftHistory,
    saveDraftHistory,
    publishDraftHistory,
    deleteDraftHistory
}
