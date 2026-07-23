import { Router } from 'express'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'
import dbContext from '../middleware/dbContext.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'
import {
    isUuid,
    sessionInClinic,
    clientInClinic,
    visibleSessionIds,
} from '../utils/mlTenant.js'

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
 *   - /phase1/status, /phase1/model         → model/readiness metadata, no tenant
 *                                              data → any authenticated user.
 *   - /phase1/sessions, /predictions/:id,
 *     /clients/:id/sessions, POST /train     → touch a clinic's sessions/clients →
 *                                              insights:read + an ownership check on
 *                                              req.dbClient (RLS-scoped) before the
 *                                              proxy. This is what stops one clinic
 *                                              reading another's insights by guessing
 *                                              a session/client UUID.
 *
 * Verifying the JWT inside ml_service instead was rejected deliberately:
 * authenticate.js also checks token revocation by jti, which is stateful, and
 * duplicating that store in a second service is how the two drift apart.
 */

const router = Router()

// Internal service address on the compose network. ml only `expose`s 8000, so this
// is not reachable from outside the stack.
const ML_BASE = process.env.ML_SERVICE_URL || 'http://ml:8000'

// Reads are quick; training can take longer. Both are bounded so a pathological
// request cannot hold a connection open indefinitely.
const READ_TIMEOUT_MS = Number(process.env.ML_READ_TIMEOUT_MS || 30000)
const TRAIN_TIMEOUT_MS = Number(process.env.ML_TRAIN_TIMEOUT_MS || 120000)

/**
 * Forward a request to ml_service and return { status, payload }. Never throws on a
 * network/parse failure — it maps that to a 502 the UI can render, because this API
 * is fine and the service behind it is not.
 */
async function mlFetch(path, { method = 'GET', body, timeoutMs = READ_TIMEOUT_MS } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let upstream
    try {
        upstream = await fetch(`${ML_BASE}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        })
    } catch (err) {
        return {
            status: 502,
            payload: {
                status: 'error',
                message:
                    err.name === 'AbortError'
                        ? 'The ML service timed out. It may still be working — check back shortly.'
                        : 'The ML service is unreachable. It may still be starting up.',
            },
        }
    } finally {
        clearTimeout(timer)
    }

    try {
        return { status: upstream.status, payload: await upstream.json() }
    } catch {
        return {
            status: 502,
            payload: { status: 'error', message: 'The ML service returned an unreadable response.' },
        }
    }
}

const send = (res, result) => res.status(result.status).json(result.payload)

// ── Model / readiness metadata — any authenticated user, no tenant data ──────────

/**
 * @openapi
 * /api/ml/phase1/status:
 *   get:
 *     summary: Phase 1 readiness snapshot (whether a model is trained, data accumulated)
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Readiness snapshot }
 *       401: { description: Missing or invalid token }
 *       502: { description: ML service unreachable }
 */
router.get('/phase1/status', catchAsync(async (req, res) => send(res, await mlFetch('/phase1/status'))))

/**
 * @openapi
 * /api/ml/phase1/model:
 *   get:
 *     summary: Current Phase 1 model + version history (model card)
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Current model and history }
 *       401: { description: Missing or invalid token }
 *       502: { description: ML service unreachable }
 */
router.get('/phase1/model', catchAsync(async (req, res) => send(res, await mlFetch('/phase1/model'))))

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
 * /api/ml/phase1/clients/{clientId}/sessions:
 *   get:
 *     summary: A client's completed sessions + personal model (training picker)
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: The client's sessions }
 *       401: { description: Missing or invalid token }
 *       403: { description: Insufficient permissions }
 *       404: { description: Client not found in the caller's clinic }
 */
router.get(
    '/phase1/clients/:clientId/sessions',
    dbContext,
    requirePermission(PERMS.INSIGHTS_READ_OWN_CLINIC),
    catchAsync(async (req, res) => {
        const { clientId } = req.params
        if (!isUuid(clientId)) throw new BadRequestError('clientId must be a UUID.')
        if (!(await clientInClinic(req.dbClient, clientId)))
            throw new NotFoundError('Client not found.')
        return send(res, await mlFetch(`/phase1/clients/${clientId}/sessions`))
    })
)

/**
 * @openapi
 * /api/ml/train:
 *   post:
 *     summary: Train a Phase 1 valence/arousal model
 *     description: >
 *       Fits and registers a model. Omit client_id for the population model, or
 *       supply one to train that client's personal model, optionally restricted to
 *       chosen sessions. A client_id / session_ids that do not belong to the
 *       caller's clinic are rejected (404) before anything is forwarded.
 *     tags: [ML]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               client_id: { type: string, format: uuid }
 *               session_ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *               predict: { type: boolean, default: true }
 *     responses:
 *       200: { description: Training finished (see `trained`) }
 *       401: { description: Missing or invalid token }
 *       404: { description: A referenced client/session is not in the caller's clinic }
 *       502: { description: ML service unreachable }
 */
router.post(
    '/train',
    dbContext,
    catchAsync(async (req, res) => {
        const { client_id, session_ids, predict } = req.body ?? {}

        if (session_ids !== undefined && !Array.isArray(session_ids))
            throw new BadRequestError('session_ids must be an array of session UUIDs.')
        if (session_ids && session_ids.length && !client_id)
            throw new BadRequestError(
                'session_ids only applies to a personal model — supply client_id too.'
            )

        // Tenant ownership: a caller may only train on their own clinic's data.
        if (client_id !== undefined && client_id !== null) {
            if (!isUuid(client_id)) throw new BadRequestError('client_id must be a UUID.')
            if (!(await clientInClinic(req.dbClient, client_id)))
                throw new NotFoundError('Client not found.')
        }
        if (session_ids && session_ids.length) {
            if (!session_ids.every(isUuid))
                throw new BadRequestError('session_ids must all be UUIDs.')
            const allowed = await visibleSessionIds(req.dbClient, session_ids)
            if (allowed.size !== session_ids.length)
                throw new NotFoundError('One or more sessions were not found.')
        }

        return send(
            res,
            await mlFetch('/phase1/train', {
                method: 'POST',
                body: { client_id, session_ids, predict },
                timeoutMs: TRAIN_TIMEOUT_MS,
            })
        )
    })
)

export default router
