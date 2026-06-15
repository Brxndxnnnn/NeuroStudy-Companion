import { Router } from 'express'
import sessionController from '../controllers/session.controller.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'

const router = Router()

/**
 * @openapi
 * /api/sessions:
 *   get:
 *     summary: List all sessions for the current clinic
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of sessions with client and technician names
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   session_id: { type: string, format: uuid }
 *                   sync_status: { type: string, example: "claimed" }
 *                   client_name: { type: string, example: "John Doe" }
 *                   technician_name: { type: string, example: "Tech 1" }
 *                   start_time: { type: string, format: date-time }
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Insufficient permissions
 */
router.get(
    '/',
    requirePermission(PERMS.SESSIONS_READ_OWN_CLINIC),
    sessionController.listSessions
)

/**
 * @openapi
 * /api/sessions/pair:
 *   patch:
 *     summary: Claim an unclaimed bridge session using a pairing code
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pairing_code, client_id]
 *             properties:
 *               pairing_code: 
 *                 type: string 
 *                 example: "ABC123"
 *               client_id:    
 *                 type: string 
 *                 format: uuid 
 *                 example: "c0000000-0000-0000-0000-000000000001"
 *     responses:
 *       200:
 *         description: Session successfully claimed and paired
 *       400:
 *         description: Bad request (missing fields)
 *       404:
 *         description: Invalid pairing code or session already claimed
 */
router.patch(
    '/pair',
    requirePermission(PERMS.SESSIONS_WRITE_OWN_CLINIC),
    sessionController.pairSessions
)

export default router