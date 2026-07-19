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
import authenticate from '../middleware/authenticate.js'
import dbContext from '../middleware/dbContext.js'
import clinicController from '../controllers/clinic.controller.js'

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
    clinicController.activateClinicDatabaseAccess
)
router.get('/health', async (req, res) => res.json({ status: 'ok' }))
router.use('/auth', authRoutes)
router.use('/users', authenticate, dbContext, usersRouter)
router.use('/clinics', authenticate, dbContext, clinicsRouter)
router.use('/sessions', authenticate, dbContext, sessionsRouter)
router.use('/events', authenticate, dbContext, eventsRouter)
router.use('/images', authenticate, dbContext, imagesRouter)
router.use('/clients', authenticate, dbContext, clientsRouter)
router.use('/questions', authenticate, dbContext, questionsRouter)
router.use('/questionnaires', authenticate, dbContext, questionnairesRouter)

export default router
