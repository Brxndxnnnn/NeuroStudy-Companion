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
 *     parameters:
 *       - in: query
 *         name: clinic_id
 *         required: false
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The UUID of the clinic to filter sessions by. Only applicable for admin users.
 *       - in: query
 *         name: sync_status
 *         required: false
 *         schema:
 *           type: string
 *         description: The sync status to filter sessions by.
 *       - in: query
 *         name: start_date
 *         required: false
 *         schema:
 *           type: string
 *           format: date-time
 *         description: The start date to filter sessions by.
 *       - in: query
 *         name: end_date
 *         required: false
 *         schema:
 *           type: string
 *           format: date-time
 *         description: The end date to filter sessions by.
 *       - in: query
 *         name: search
 *         required: false
 *         schema:
 *           type: string
 *         description: Searches session ID, status, device, client, and technician.
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: page_size
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *     responses:
 *       200:
 *         description: A paginated session list, including totals by status.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       session_id: { type: string, format: uuid }
 *                       sync_status: { type: string, example: "claimed" }
 *                       client_name: { type: string, example: "John Doe" }
 *                       technician_name: { type: string, example: "Tech 1" }
 *                       start_time: { type: string, format: date-time }
 *                 pagination:
 *                   type: object
 *                 status_counts:
 *                   type: object
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
 * /api/sessions/{session_id}:
 *   get:
 *     summary: Get a specific session by its ID
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *     responses:
 *       200:
 *         description: Session found
 *       404:
 *         description: Session not found
 */
router.get(
    '/:session_id',
    requirePermission(PERMS.SESSIONS_READ_OWN_CLINIC),
    sessionController.getSessionById
)

/**
 * @openapi
 * /api/sessions/{session_id}:
 *   delete:
 *     summary: Permanently delete a session (admin only)
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Session deleted successfully
 *       403:
 *         description: Administrator access is required
 *       404:
 *         description: Session not found
 */
router.delete(
    '/:session_id',
    requirePermission(PERMS.SESSIONS_WRITE_ALL),
    sessionController.deleteSession
)

/**
 * @openapi
 * /api/sessions/pair:
 *   patch:
 *     summary: Claim an unclaimed bridge session using a pairing code
 *     description: |
 *       Pairs an unclaimed EEG session with a specific client and technician.
 *       
 *       **Note on Technician & Clinic IDs:** 
 *       The frontend does NOT need to send the technician's `user_id` or `clinic_id`. 
 *       The backend automatically extracts the `conducted_by` (user_id) and `clinic_id` 
 *       from the signed JWT (Bearer token) provided in the Authorization header.
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
 *                 description: The 6-character pairing code generated by the C# bridge.
 *                 example: "ABC123"
 *               client_id:    
 *                 type: string 
 *                 format: uuid 
 *                 description: The UUID of the client selected by the technician in the frontend.
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

// No /:session_id/start route: the bridge owns the recording-start transition (writes
// sync_status='recording' + start_time itself via DbUploader.MarkRecording). The website
// only observes it by polling GET /:session_id and showing "awaiting technician".

/**
 * @openapi
 * /api/sessions/{session_id}/end:
 *   patch:
 *     summary: End a session by setting its sync_status to "completed" and recording the end_time
 *     description: |
 *       This endpoint allows you to end a specific session. You must provide the session_id in the URL.
 * 
 *       **Note**: The `session_id` must be a valid UUID. If the provided ID does not exist in the database, an error will be returned.
 *       This endpoint also triggers the backfilling of session results for the specified session.
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *     responses:
 *       200:
 *         description: Session successfully ended
 *       400:
 *         description: Bad request (missing fields)
 *       404:
 *         description: Could not find session with the provided session_id
 */
router.patch(
    '/:session_id/end',
    requirePermission(PERMS.SESSIONS_WRITE_OWN_CLINIC),
    sessionController.endSession
)

/**
 * @openapi
 * /api/sessions/{session_id}/results:
 *   get:
 *     summary: Retrieve the results for a specific session
 *     description: |
 *       This endpoint allows you to retrieve the results for a specific session. You must provide the session_id in the URL.
 * 
 *       **Note**: The `session_id` must be a valid UUID. If the provided ID does not exist in the database, an error will be returned.
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *     responses:
 *       200:
 *         description: Results retrieved successfully
 *       404:
 *         description: Could not find session with the provided session_id
 */
router.get(
    '/:session_id/results',
    requirePermission(PERMS.SESSIONS_READ_OWN_CLINIC),
    sessionController.getSessionResult
)

/**
 * @openapi
 * /api/sessions/{session_id}/results/raw:
 *   get:
 *     summary: Retrieve the raw results for a specific session
 *     description: |
 *       This endpoint allows you to retrieve the raw results for a specific session. You must provide the session_id in the URL.
 * 
 *       **Note**: The `session_id` must be a valid UUID. If the provided ID does not exist in the database, an error will be returned.
 *       
 *       This API right now quite slow since DB is on the $4 droplet, try like 5-10 seconds, at most can try 1 minute interval (0 to 60) 
 *       or (60 to 120) to get the filtered results. We will optimize this in the future.
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *       - in: query
 *         name: start_seconds
 *         required: true
 *         schema:
 *           type: number
 *           description: The starting point in seconds from which to retrieve the raw results.
 *       - in: query
 *         name: end_seconds
 *         required: true
 *         schema:
 *           type: number
 *           description: The ending point in seconds up to which to retrieve the raw results.
 *     responses:
 *       200:
 *         description: Raw results retrieved successfully
 *       404:
 *         description: Could not find session with the provided session_id
 */
router.get(
    '/:session_id/results/raw',
    requirePermission(PERMS.SESSIONS_READ_OWN_CLINIC),
    sessionController.getSessionEEGResults
)


/**
 * @openapi
 * /api/sessions/{session_id}/results/filtered:
 *   get:
 *     summary: Retrieve the filtered results for a specific session
 *     description: |
 *       This endpoint allows you to retrieve the filtered results for a specific session. You must provide the session_id in the URL.
 * 
 *       **Note**: The `session_id` must be a valid UUID. If the provided ID does not exist in the database, an error will be returned.
 *       
 *       This API right now quite slow since DB is on the $4 droplet, try like 5-10 seconds, at most can try 1 minute interval (0 to 60) 
 *       or (60 to 120) to get the filtered results. We will optimize this in the future.
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *       - in: query
 *         name: start_seconds
 *         required: true
 *         schema:
 *           type: number
 *         description: The starting point in seconds from which to retrieve the filtered results.
 *       - in: query
 *         name: end_seconds
 *         required: true
 *         schema:
 *           type: number
 *         description: The ending point in seconds up to which to retrieve the filtered results.
 *     responses:
 *       200:
 *         description: Filtered results retrieved successfully
 *       404:
 *         description: Could not find session with the provided session_id
 */
router.get(
    '/:session_id/results/filtered',
    requirePermission(PERMS.SESSIONS_READ_OWN_CLINIC),
    sessionController.getSessionEEGResults
)

/**
 * @openapi
 * /api/sessions/{session_id}/results/bandpower:
 *  get:
 *    summary: Retrieve the band power results for a specific session
 *    description: |
 *      This endpoint allows you to retrieve the band power results for a specific session. You must provide the session_id in the URL.
 *
 *      **Note**: The `session_id` must be a valid UUID. If the provided ID does not exist in the database, an error will be returned.
 *
 *      This API can leave start_seconds and end_seconds empty to get the entire session results, since the band power results are already downsampled to 1Hz, 
 *      it should be fast enough to retrieve the entire session results.
 *    tags: [Sessions]
 *    security:
 *      - bearerAuth: []
 *    parameters:
 *      - in: path
 *        name: session_id
 *        required: true
 *      - in: query
 *        name: start_seconds
 *        required: false
 *        schema:
 *          type: number
 *          description: The starting point in seconds from which to retrieve the band power results. Defaults to the beginning of the session if not provided.
 *      - in: query
 *        name: end_seconds
 *        required: false
 *        schema:
 *          type: number
 *          description: The ending point in seconds up to which to retrieve the band power results. Defaults to the beginning of the session if not provided.
 *    responses:
 *      200:
 *        description: Band power results retrieved successfully
 *      404:
 *        description: Could not find session with the provided session_id
 */
router.get(
    '/:session_id/results/bandpower',
    requirePermission(PERMS.SESSIONS_READ_OWN_CLINIC),
    sessionController.getSessionBandPowerResults
)

/**
 * @openapi
 * /api/sessions/{session_id}/results/elliptic_band_stats:
 *  get:
 *    summary: Retrieve the elliptic band stats for a specific session
 *    description: |
 *      This endpoint allows you to retrieve the elliptic band stats for a specific session. You must provide the session_id in the URL.
 *
 *      **Note**: The `session_id` must be a valid UUID. If the provided ID does not exist in the database, an error will be returned.
 *    tags: [Sessions]
 *    security:
 *      - bearerAuth: []
 *    parameters:
 *      - in: path
 *        name: session_id
 *        required: true
 *    responses:
 *      200:
 *        description: Elliptic band stats retrieved successfully
 *      404:
 *        description: Could not find session with the provided session_id
 */
router.get(
    '/:session_id/results/elliptic_band_stats',
    requirePermission(PERMS.SESSIONS_READ_OWN_CLINIC),
    sessionController.getSessionEllipticBandStats
)

/**
 * @openapi
 * /api/sessions/{session_id}/results/fft_bandpower:
 *  get:
 *    summary: Retrieve our FFT-computed band powers for a specific session
 *    description: |
 *      Band powers computed by the ML service via FFT on the filtered EEG — the
 *      replacement source for the "Frequency bands" chart (rather than the SenseBand
 *      SDK's band_powers). Already downsampled, so the whole session is returned.
 *
 *      **Note**: The `session_id` must be a valid UUID.
 *    tags: [Sessions]
 *    security:
 *      - bearerAuth: []
 *    parameters:
 *      - in: path
 *        name: session_id
 *        required: true
 *    responses:
 *      200:
 *        description: FFT band powers retrieved successfully
 *      404:
 *        description: Could not find session with the provided session_id
 */
router.get(
    '/:session_id/results/fft_bandpower',
    requirePermission(PERMS.SESSIONS_READ_OWN_CLINIC),
    sessionController.getSessionFftBandPowerResults
)

export default router
