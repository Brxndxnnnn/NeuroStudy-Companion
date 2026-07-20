import { Router } from 'express'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError } from '../utils/AppError.js'

/**
 * Authenticated front door to the ML service.
 *
 * WHY THIS EXISTS: ml_service has no authentication of its own, and nginx exposes
 * it at /ml/ for the Insights tab's read-only endpoints. Training is different — it
 * writes a model, promotes it, and rewrites predictions — so it must not be
 * reachable by anyone who can reach the host. This route is the only path the UI
 * uses to trigger training: it authenticates with the same middleware as every
 * other write in this API, then forwards to ml_service over the internal compose
 * network, which is not routable from outside.
 *
 * Verifying the JWT inside ml_service instead was rejected deliberately:
 * authenticate.js also checks token revocation by jti, which is stateful, and
 * duplicating that store in a second service is how the two drift apart.
 */

const router = Router()

// Internal service address on the compose network. ml only `expose`s 8000, so this
// is not reachable from outside the stack.
const ML_BASE = process.env.ML_SERVICE_URL || 'http://ml:8000'

// Training on this project's data takes seconds, but a pathological dataset must
// not hold a request open indefinitely.
const TRAIN_TIMEOUT_MS = Number(process.env.ML_TRAIN_TIMEOUT_MS || 120000)

/**
 * @openapi
 * /api/ml/train:
 *   post:
 *     summary: Train a Phase 1 valence/arousal model
 *     description: >
 *       Fits and registers a model. Omit client_id for the population model, or
 *       supply one to train that client's personal model, optionally restricted to
 *       chosen sessions. A personal model always becomes the one that client's
 *       Insights tab uses; its honest accuracy is returned alongside.
 *     tags: [ML]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               client_id:
 *                 type: string
 *                 format: uuid
 *               session_ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *               predict:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Training finished (see `trained` for whether a model was fitted).
 *       401:
 *         description: Missing or invalid token.
 *       502:
 *         description: The ML service is unreachable or returned an unreadable response.
 */
router.post(
    '/train',
    catchAsync(async (req, res) => {
        const { client_id, session_ids, predict } = req.body ?? {}

        if (session_ids !== undefined && !Array.isArray(session_ids))
            throw new BadRequestError('session_ids must be an array of session UUIDs.')
        if (session_ids && session_ids.length && !client_id)
            throw new BadRequestError(
                'session_ids only applies to a personal model — supply client_id too.'
            )

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TRAIN_TIMEOUT_MS)

        let upstream
        try {
            upstream = await fetch(`${ML_BASE}/phase1/train`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_id, session_ids, predict }),
                signal: controller.signal,
            })
        } catch (err) {
            // Unreachable or timed out. 502 rather than 500: this API is fine, the
            // service behind it is not, and the UI should say so.
            return res.status(502).json({
                status: 'error',
                message:
                    err.name === 'AbortError'
                        ? 'Training timed out. The ML service may still be working — check back shortly.'
                        : 'The ML service is unreachable. It may still be starting up.',
            })
        } finally {
            clearTimeout(timer)
        }

        let payload
        try {
            payload = await upstream.json()
        } catch {
            return res.status(502).json({
                status: 'error',
                message: 'The ML service returned an unreadable response.',
            })
        }

        return res.status(upstream.status).json(payload)
    })
)

export default router
