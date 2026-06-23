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

const router = Router()

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
