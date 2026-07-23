import { Router } from 'express'
import authRoutes from './auth.routes.js'
import usersRouter from './users.routes.js'
import clinicsRouter from './clinics.routes.js'
import sessionsRouter from './sessions.routes.js'
import eventsRouter from './events.routes.js'
import imagesRouter from './images.routes.js'
import clientsRouter from './clients.routes.js'
import questionsRouter from './questions.routes.js'
import questionnairesRouter from './questionnaires.routes.js'
import mlRouter from './ml.routes.js'
import authenticate from '../middleware/authenticate.js'
import dbContext from '../middleware/dbContext.js'
import clinicController from '../controllers/clinic.controller.js'
import eventsController from '../controllers/event.controller.js'
import { activationLimiter, authenticatedApiLimiter } from '../middleware/rateLimiters.js'

const router = Router()


// Must be a public route because the clinic is not yet activated and therefore cannot authenticate
/**
 * @openapi
 * /api/clinics/activate:
 *   post:
 *     summary: Activate a clinic desktop installation
 *     tags: [Clinics]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - activation_code
 *             properties:
 *               activation_code:
 *                 type: string
 *                 example: A1B2-C3D4-E5F6-A7BE
 *     responses:
 *       200:
 *         description: Installation activated
 *       400:
 *         description: Invalid, expired, revoked or used activation code
 */
router.post(
    '/clinics/activate',
    activationLimiter,
    clinicController.activateClinicDatabaseAccess
)
router.get('/time', eventsController.getServerTime)
router.get('/health', async (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))
router.use('/auth', authRoutes)
// Everything below this line will run through `authenticate` and `authenticatedApiLimiter`
router.use(authenticate)
router.use(authenticatedApiLimiter)
// No dbContext: this only proxies to ml_service, which holds its own connection as
// a BYPASSRLS role. Opening a tenant-scoped backend connection here would be dead weight.
router.use('/ml', mlRouter)
// Everything below this line will run through `dbContext` (in addition to authentication)
router.use(dbContext)
router.use('/users', usersRouter)
router.use('/clinics', clinicsRouter)
router.use('/sessions', sessionsRouter)
router.use('/events', eventsRouter)
router.use('/images', imagesRouter)
router.use('/clients', clientsRouter)
router.use('/questions', questionsRouter)
router.use('/questionnaires', questionnairesRouter)

export default router
