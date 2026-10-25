import { Router } from 'express'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'
import dbContext from '../middleware/dbContext.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'
import {
    isUuid,
    sessionInClinic,
    visibleSessionIds,
    visibleClientIds,
} from '../utils/mlTenant.js'
import { mlFetch, send } from '../utils/mlClient.js'
import mlGroupController from '../controllers/mlGroup.controller.js'

/**
 * Authenticated front door to the ML service.
 *
 * WHY THIS EXISTS: ml_service has no authentication of its own and connects to the
 * DB as a BYPASSRLS role, so it can neither identify a caller nor enforce the
 * per-clinic row-level security the rest of the API relies on. It is therefore NOT
 * exposed publicly — nginx no longer routes /ml/, and the container only `expose`s
 * its port on the internal compose network. EVERY browser call to the ML service
 * comes through this router: it authenticates with the same middleware as the rest
 * of the API, enforces clinic ownership on anything session- or client-scoped, and
 * only then forwards to ml_service.
 *
 * Split of concerns:
 *   - /phase1/status                        → readiness metadata, no tenant data →
 *                                              any authenticated user.
 *   - /phase1/sessions, /predictions/:id,
 *     /phase1/eligibility                  → touch a clinic's sessions/clients →
 *                                              insights:read + an ownership check on
 *                                              req.dbClient (RLS-scoped) before the
 *                                              proxy. This is what stops one clinic
 *                                              reading another's insights by guessing
 *                                              a session/client UUID.
 *   - /groups (CRUD), /groups/:id/train     → ML groups (migration 025): clinic data
 *                                              read/written under RLS here, then
 *                                              training proxied. Writes need
 *                                              insights:write.
 *
 * Verifying the JWT inside ml_service instead was rejected deliberately:
 * authenticate.js also checks token revocation by jti, which is stateful, and
 * duplicating that store in a second service is how the two drift apart.
 */

const router = Router()

// ── Readiness metadata — any authenticated user, no tenant data ──────────────────

/**
 * @openapi
 * /api/ml/phase1/status:
 *   get:
 *     summary: Phase 1 readiness snapshot (labelled EEG data accumulated)
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Readiness snapshot }
 *       401: { description: Missing or invalid token }
 *       502: { description: ML service unreachable }
 */
router.get('/phase1/status', catchAsync(async (req, res) => send(res, await mlFetch('/phase1/status'))))

// ── Session-scoped reads — insights:read + clinic ownership ──────────────────────

/**
 * @openapi
 * /api/ml/phase1/sessions:
 *   get:
 *     summary: Completed sessions with predictions, scoped to the caller's clinic
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Sessions visible to the caller's clinic }
 *       401: { description: Missing or invalid token }
 *       403: { description: Insufficient permissions }
 */
router.get(
    '/phase1/sessions',
    dbContext,
    requirePermission(PERMS.INSIGHTS_READ_OWN_CLINIC),
    catchAsync(async (req, res) => {
        const result = await mlFetch('/phase1/sessions')
        // ml_service returns every clinic's sessions; trim to those visible to the
        // caller. RLS on req.dbClient decides visibility (admins see all).
        if (result.status === 200 && Array.isArray(result.payload?.sessions)) {
            const ids = result.payload.sessions.map((s) => s.session_id).filter(isUuid)
            const allowed = await visibleSessionIds(req.dbClient, ids)
            result.payload = {
                ...result.payload,
                sessions: result.payload.sessions.filter((s) => allowed.has(s.session_id)),
            }
        }
        return send(res, result)
    })
)

/**
 * @openapi
 * /api/ml/phase1/predictions/{sessionId}:
 *   get:
 *     summary: One session's predicted valence/arousal trajectory
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: model_version
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Prediction trajectory }
 *       401: { description: Missing or invalid token }
 *       403: { description: Insufficient permissions }
 *       404: { description: Session not found in the caller's clinic }
 */
router.get(
    '/phase1/predictions/:sessionId',
    dbContext,
    requirePermission(PERMS.INSIGHTS_READ_OWN_CLINIC),
    catchAsync(async (req, res) => {
        const { sessionId } = req.params
        if (!isUuid(sessionId)) throw new BadRequestError('sessionId must be a UUID.')
        if (!(await sessionInClinic(req.dbClient, sessionId)))
            throw new NotFoundError('Session not found.')

        const mv = req.query.model_version
        const qs = mv !== undefined ? `?model_version=${encodeURIComponent(mv)}` : ''
        return send(res, await mlFetch(`/phase1/predictions/${sessionId}${qs}`))
    })
)

/**
 * @openapi
 * /api/ml/phase1/eligibility:
 *   get:
 *     summary: Per client, what a group model would train on
 *     description: >
 *       Each client's latest trainable session (completed, EEG stored, enough labelled
 *       images) and whether a complete BFI-2 exists. Shown in the group editor. Trimmed
 *       to clients visible to the caller's clinic.
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Eligibility per client }
 *       401: { description: Missing or invalid token }
 *       403: { description: Insufficient permissions }
 */
router.get(
    '/phase1/eligibility',
    dbContext,
    requirePermission(PERMS.INSIGHTS_READ_OWN_CLINIC),
    catchAsync(async (req, res) => {
        const result = await mlFetch('/phase1/eligibility')
        if (result.status === 200 && Array.isArray(result.payload?.clients)) {
            const ids = result.payload.clients.map((c) => c.client_id).filter(isUuid)
            const allowed = await visibleClientIds(req.dbClient, ids)
            result.payload = {
                ...result.payload,
                clients: result.payload.clients.filter((c) => allowed.has(c.client_id)),
            }
        }
        return send(res, result)
    })
)

// ── ML groups ────────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/ml/groups:
 *   get:
 *     summary: The caller's ML groups, members and current models
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Groups with members and current_model (null until trained) }
 *       401: { description: Missing or invalid token }
 *       403: { description: Insufficient permissions }
 *   post:
 *     summary: Create an ML group
 *     description: >
 *       A named set of clients whose latest labelled sessions train one model. Members
 *       must belong to the caller's clinic (an admin's group takes its members' clinic).
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, client_ids]
 *             properties:
 *               name: { type: string, maxLength: 80 }
 *               client_ids: { type: array, items: { type: string, format: uuid } }
 *     responses:
 *       201: { description: Created; returns group_id }
 *       400: { description: Invalid name/members, or a member from another clinic }
 *       409: { description: The clinic already has a group with that name }
 */
router.get('/groups', dbContext, requirePermission(PERMS.INSIGHTS_READ_OWN_CLINIC), mlGroupController.listGroups)
router.post('/groups', dbContext, requirePermission(PERMS.INSIGHTS_WRITE_OWN_CLINIC), mlGroupController.createGroup)

/**
 * @openapi
 * /api/ml/groups/{groupId}:
 *   put:
 *     summary: Rename an ML group and/or replace its members
 *     description: >
 *       A trained model keeps the members and sessions it was trained on; the change
 *       applies from the next train.
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: groupId, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, maxLength: 80 }
 *               client_ids: { type: array, items: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Updated }
 *       404: { description: Group not found in the caller's clinic }
 *   delete:
 *     summary: Delete an ML group with its models and their predictions
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: groupId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Group not found in the caller's clinic }
 */
router.put('/groups/:groupId', dbContext, requirePermission(PERMS.INSIGHTS_WRITE_OWN_CLINIC), mlGroupController.updateGroup)
router.delete('/groups/:groupId', dbContext, requirePermission(PERMS.INSIGHTS_WRITE_OWN_CLINIC), mlGroupController.deleteGroup)

/**
 * @openapi
 * /api/ml/groups/{groupId}/train:
 *   post:
 *     summary: Train an ML group's model
 *     description: >
 *       Random forest on each member's latest labelled session, with their BFI-2 domain
 *       scores as extra inputs. Scored by holding one person and their test images out,
 *       with and without BFI, against predicting the average. Members without a
 *       trainable session or a complete BFI-2 are left out and listed in `skipped`.
 *       Unless predict is false, the new model then predicts every member's sessions.
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: groupId, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               predict: { type: boolean, default: true }
 *     responses:
 *       200: { description: Finished — see `trained`, `message`, `skipped`, scores }
 *       404: { description: Group not found in the caller's clinic }
 *       502: { description: ML service unreachable }
 */
router.post('/groups/:groupId/train', dbContext, requirePermission(PERMS.INSIGHTS_WRITE_OWN_CLINIC), mlGroupController.trainGroup)

export default router
