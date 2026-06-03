import { Router } from 'express'
import authRoutes from './auth.routes.js'
import usersRouter from './users.routes.js'
import clinicsRouter from './clinics.routes.js'

const router = Router()

router.get('/health', async (req, res) => res.json({ status: 'ok' }))
router.use('/auth', authRoutes)
router.use('/users', usersRouter)
router.use('/clinics', clinicsRouter)

export default router
