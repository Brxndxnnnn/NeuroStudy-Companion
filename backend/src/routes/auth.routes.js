import { Router } from 'express'
import authController from '../controllers/auth.controller.js'
import authenticate from '../middleware/authenticate.js'
import dbContext from '../middleware/dbContext.js'

const router = Router()
/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login and receive a JWT
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, override]
 *             properties:
 *               email:
 *                 type: string
 *                 example: admin@neurostudy.com
 *               password:
 *                 type: string
 *                 example: password123
 *               override:
 *                 type: boolean
 *                 description: "Set to true to override any existing active session for this user if one exists."
 *                 example: false
 *     responses:
 *       200:
 *         description: JWT token and user info
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Active session exists and override not yet confirmed
 */
router.post('/login', authController.login)

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh an expired access token using the HttpOnly refresh token cookie
 *     tags: [Auth]
 *     security: [] # Overrides global Bearer requirement; relies on cookie instead
 *     responses:
 *       200:
 *         description: New access token issued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken:
 *                   type: string
 *                   description: The new short-lived JWT access token
 *       401:
 *         description: No refresh token provided, or session is invalid/expired
 */
router.post('/refresh', authController.refresh)

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Revoke the current JWT
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       401:
 *         description: Not authenticated
 */
router.post('/logout', authenticate, dbContext, authController.logout)

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current authenticated user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user profile
 *       401:
 *         description: Not authenticated
 */
router.get('/me', authenticate, dbContext, authController.me)

export default router