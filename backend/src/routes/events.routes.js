import { Router } from 'express'
import eventController from '../controllers/event.controller.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'

const router = Router()

/**
 * @openapi
 * /api/events:
 *   post:
 *     summary: Create a new event for a session
 *     description: |
 *       This endpoint allows you to create a new event for a specific session. You must provide the session_id and image_id in the request body. 
 *       The event will be associated with the clinic of the authenticated user.
 * 
 *       **Note**: The `session_id` and `image_id` must be valid UUIDs. If the provided IDs do not exist in the database, an error will be returned.
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               session_id: { type: string, format: uuid }
 *               image_id: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Event created successfully
 *       400:
 *         description: Missing required fields
 *       401:
 *         description: Not authenticated
 */
router.post(
    '/',
    requirePermission(PERMS.EVENTS_WRITE_OWN_CLINIC),
    eventController.createEvent
)

/**
 * @openapi
 * /api/events/{event_id}/hide:
 *   patch:
 *     summary: Mark an event as hidden by setting its hidden_at timestamp
 *     description: |
 *       This endpoint allows you to mark a specific event as hidden. You must provide the event_id in the URL. 
 *       The event will be associated with the clinic of the authenticated user.
 * 
 *       **Note**: The `event_id` must be a valid UUID. If the provided ID does not exist in the database, an error will be returned.
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: event_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Event updated successfully
 *       404:
 *         description: Event not found
 */
router.patch(
    '/:event_id/hide',
    requirePermission(PERMS.EVENTS_WRITE_OWN_CLINIC),
    eventController.updateEvent
)

export default router