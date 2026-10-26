import mlGroupModel from '../models/mlGroup.model.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'
import { isUuid, validateGroupBody } from '../validators/mlGroup.validators.js'
import { mlFetch, send, COMPARE_TIMEOUT_MS } from '../utils/mlClient.js'

// ML groups (ITP2, 21 Oct 2026): a technician puts clients into a named group and trains
// one Phase 1 model on each member's latest labelled session. Groups are clinic data, so
// they live behind RLS here; ml_service only reads them when training.

const groupIdParam = (req) => {
    const { groupId } = req.params
    if (!isUuid(groupId)) throw new BadRequestError('groupId must be a UUID.')
    return groupId
}

// ── GET /api/ml/groups ────────────────────────────────────────────────────────────
// The caller's groups with their members and, when trained, the current model and its
// scores. The model list comes from ml_service (cross-clinic) and is matched to the
// groups the caller can see, so nothing from another clinic leaks through.
const listGroups = catchAsync(async (req, res) => {
    const groups = await mlGroupModel.listWithMembers(req.dbClient)
    const models = await mlFetch('/phase1/groups/models')
    const byGroup = new Map(
        models.status === 200 && Array.isArray(models.payload?.models)
            ? models.payload.models.map(m => [m.group_id, m])
            : []
    )
    return res.json({
        groups: groups.map(g => ({ ...g, current_model: byGroup.get(g.group_id) ?? null })),
        models_available: models.status === 200,
    })
})

// ── POST /api/ml/groups ───────────────────────────────────────────────────────────
const createGroup = catchAsync(async (req, res) => {
    const { name, client_ids } = validateGroupBody(req.body)

    // A technician's group belongs to their clinic. An admin has no clinic of their own,
    // so the group takes the clinic its members share.
    let clinic_id = req.user.clinic_id
    if (!clinic_id) {
        const clinics = await mlGroupModel.clinicsOfClients(client_ids, req.dbClient)
        if (clinics.length === 0) throw new NotFoundError('None of those clients were found.')
        if (clinics.length !== 1)
            throw new BadRequestError('All members of a group must belong to the same clinic.')
        clinic_id = clinics[0]
    }

    const group_id = await mlGroupModel.create(
        { name, clinic_id, created_by: req.user.sub ?? null, client_ids }, req.dbClient)
    return res.status(201).json({ group_id })
})

// ── PUT /api/ml/groups/:groupId ───────────────────────────────────────────────────
// Renames and/or replaces the member list. A trained model keeps the members and
// sessions it was trained on; the change applies from the next Train.
const updateGroup = catchAsync(async (req, res) => {
    const groupId = groupIdParam(req)
    const changes = validateGroupBody(req.body, { partial: true })
    if (!(await mlGroupModel.update(groupId, changes, req.dbClient)))
        throw new NotFoundError('Group not found.')
    return res.json({ group_id: groupId })
})

// ── DELETE /api/ml/groups/:groupId ────────────────────────────────────────────────
const deleteGroup = catchAsync(async (req, res) => {
    const groupId = groupIdParam(req)
    if (!(await mlGroupModel.remove(groupId, req.dbClient)))
        throw new NotFoundError('Group not found.')
    return res.status(204).end()
})

// ── POST /api/ml/groups/:groupId/train ────────────────────────────────────────────
// Starts training in the background on ml_service: 202 straight away, 409 if the group
// is already training. Progress is on the group (train_status etc.), which GET /groups
// returns, so the page polls that rather than holding this request open for minutes.
const trainGroup = catchAsync(async (req, res) => {
    const groupId = groupIdParam(req)
    if (!(await mlGroupModel.findById(groupId, req.dbClient)))
        throw new NotFoundError('Group not found.')
    const predict = req.body?.predict !== false
    return send(res, await mlFetch(`/phase1/groups/${groupId}/train`, {
        method: 'POST', body: { predict },
    }))
})

// ── GET /api/ml/groups/:groupId/fit?client_id= ────────────────────────────────────
// How a client outside the group compares with it (personality, EEG profile, response
// to the group's model). Read-only. The group and the client must both be visible to
// the caller and belong to the same clinic; ml_service has no tenant checks of its own.
const compareClient = catchAsync(async (req, res) => {
    const groupId = groupIdParam(req)
    const clientId = req.query.client_id
    if (!isUuid(clientId)) throw new BadRequestError('client_id must be a UUID.')
    const group = await mlGroupModel.findById(groupId, req.dbClient)
    if (!group) throw new NotFoundError('Group not found.')
    const clinicId = await mlGroupModel.clinicOfClient(clientId, req.dbClient)
    if (!clinicId) throw new NotFoundError('Client not found.')
    if (clinicId !== group.clinic_id)
        throw new BadRequestError('The client belongs to a different clinic from the group.')
    return send(res, await mlFetch(
        `/phase1/groups/${groupId}/fit?client_id=${encodeURIComponent(clientId)}`,
        { timeoutMs: COMPARE_TIMEOUT_MS }))
})

export default { listGroups, createGroup, updateGroup, deleteGroup, trainGroup, compareClient }
