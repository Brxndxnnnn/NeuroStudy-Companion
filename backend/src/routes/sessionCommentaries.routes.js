import { Router } from 'express'
import sessionCommentaryController from '../controllers/sessionCommentary.controller.js'
import requirePermission from '../middleware/requirePermission.js'
import validateRequest from '../middleware/validateRequest.js'
import { commentaryIdValidation, sessionIdValidation } from '../validators/sessionCommentary.validators.js'
import PERMS from '../constants/permissions.js'

// Mounted at /api/sessions/:session_id/commentaries; mergeParams exposes :session_id.
const router = Router({ mergeParams: true })

/**
 * @openapi
 * components:
 *   schemas:
 *     SessionCommentaryInput:
 *       type: object
 *       description: |
 *         The technician's post-session commentary for the Section A report. Every
 *         section is required to publish; drafts may leave any of them out.
 *       example:
 *         anamnesis: "The client reported early learning difficulties and ongoing problems with attention. Sleep is irregular, typically starting around midnight. Treatment goals are to improve focus and writing ability."
 *         eeg_premeasurement: "Neurofeedback pre-measurement was performed using a quantitative EEG to determine the proportion of different frequencies. Brain activity was measured at rest with eyes closed and open, and during a cognitively demanding task."
 *         eeg_eyes_closed: "Mildly fast (beta) background activity was observed, with slow-wave activity."
 *         eeg_eyes_open: "A mix of slow and slightly faster brain activity was noted."
 *         eeg_cognitive_task: "A mix of slow and slightly faster brain activity was noted while performing the task."
 *         eeg_conclusion: "It is recommended to start neurofeedback training at the frontal lobe (Fz), inhibiting Beta 2. A re-measurement should follow after 10 treatments."
 *         prognostic_estimation: "With regular neurofeedback training and good motivation, the client could reduce concentration problems in everyday life."
 *       properties:
 *         anamnesis:             { type: string }
 *         eeg_premeasurement:    { type: string, description: "EEG Pre Measurement: EEG premeasurement" }
 *         eeg_eyes_closed:       { type: string, description: "Resting state recording with eyes closed" }
 *         eeg_eyes_open:         { type: string, description: "Recording with eyes open" }
 *         eeg_cognitive_task:    { type: string, description: "Recording during performance of a cognitively responsive task" }
 *         eeg_conclusion:        { type: string, description: "EEG Pre Measurement: Conclusion" }
 *         prognostic_estimation: { type: string }
 *     SessionCommentary:
 *       allOf:
 *         - $ref: '#/components/schemas/SessionCommentaryInput'
 *         - type: object
 *           properties:
 *             commentary_id: { type: string, format: uuid }
 *             session_id:    { type: string, format: uuid }
 *             clinic_id:     { type: string, format: uuid }
 *             version:       { type: integer, nullable: true, description: "Null while draft" }
 *             status:        { type: string, enum: [draft, active, superseded] }
 *             created_by:    { type: string, format: uuid, nullable: true }
 *             created_at:    { type: string, format: date-time }
 *             updated_at:    { type: string, format: date-time }
 *             published_by:  { type: string, format: uuid, nullable: true }
 *             published_at:  { type: string, format: date-time, nullable: true }
 *     SessionCommentarySummary:
 *       type: object
 *       properties:
 *         commentary_id: { type: string, format: uuid }
 *         version:       { type: integer, nullable: true, description: "Null while draft" }
 *         status:        { type: string, enum: [draft, active, superseded] }
 *         created_by:    { type: string, format: uuid, nullable: true }
 *         created_at:    { type: string, format: date-time }
 *         updated_at:    { type: string, format: date-time }
 *         published_by:  { type: string, format: uuid, nullable: true }
 *         published_at:  { type: string, format: date-time, nullable: true }
 */

/**
 * @openapi
 * /api/sessions/{session_id}/commentaries:
 *   get:
 *     summary: List every version of a session's commentary
 *     description: |
 *       Newest first, with the draft (if any) at the top. Section text is not included;
 *       fetch a version by ID for its content.
 *     tags: [Session Commentaries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: session_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The session's commentary versions
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/SessionCommentarySummary' }
 *       404:
 *         description: Session not found
 */
router.get(
    '/',
    requirePermission(PERMS.SESSION_COMMENTARIES_READ_OWN_CLINIC),
    sessionIdValidation,
    validateRequest,
    sessionCommentaryController.listCommentaries
)

/**
 * @openapi
 * /api/sessions/{session_id}/commentaries/active:
 *   get:
 *     summary: Get a session's published (active) commentary
 *     tags: [Session Commentaries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: session_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The commentary the PDF report requires
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SessionCommentary' }
 *       404:
 *         description: Session not found, or it has no published commentary
 */
router.get(
    '/active',
    requirePermission(PERMS.SESSION_COMMENTARIES_READ_OWN_CLINIC),
    sessionIdValidation,
    validateRequest,
    sessionCommentaryController.getActiveCommentary
)

/**
 * @openapi
 * /api/sessions/{session_id}/commentaries/draft:
 *   get:
 *     summary: Get a session's draft commentary
 *     tags: [Session Commentaries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: session_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The draft with whatever text has been saved
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SessionCommentary' }
 *       404:
 *         description: Session not found, or it has no draft
 */
router.get(
    '/draft',
    requirePermission(PERMS.SESSION_COMMENTARIES_READ_OWN_CLINIC),
    sessionIdValidation,
    validateRequest,
    sessionCommentaryController.getDraftCommentary
)

/**
 * @openapi
 * /api/sessions/{session_id}/commentaries/draft:
 *   put:
 *     summary: Create or replace a session's draft commentary
 *     description: |
 *       Saves the whole draft: sections not supplied are cleared. Incomplete drafts are
 *       allowed. Only completed sessions can have commentary. To edit a published
 *       commentary, load it from /active and save it here as a new draft.
 *     tags: [Session Commentaries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: session_id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/SessionCommentaryInput' }
 *     responses:
 *       200:
 *         description: The saved draft
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SessionCommentary' }
 *       400:
 *         description: Invalid values
 *       404:
 *         description: Session not found
 *       409:
 *         description: The session has not completed
 */
router.put(
    '/draft',
    requirePermission(PERMS.SESSION_COMMENTARIES_WRITE_OWN_CLINIC),
    sessionIdValidation,
    validateRequest,
    sessionCommentaryController.saveDraftCommentary
)

/**
 * @openapi
 * /api/sessions/{session_id}/commentaries/draft/publish:
 *   post:
 *     summary: Publish a session's draft commentary
 *     description: |
 *       No request body: publishes the saved draft. It becomes the active commentary
 *       with the next version number, the previous active one is superseded, and the
 *       session's PDF report can then be generated.
 *     tags: [Session Commentaries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: session_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The published commentary
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SessionCommentary' }
 *       400:
 *         description: The draft is incomplete; the message lists what is missing
 *       404:
 *         description: Session not found, or it has no draft
 *       409:
 *         description: The draft was published or discarded by another request, or the session has not completed
 */
router.post(
    '/draft/publish',
    requirePermission(PERMS.SESSION_COMMENTARIES_WRITE_OWN_CLINIC),
    sessionIdValidation,
    validateRequest,
    sessionCommentaryController.publishDraftCommentary
)

/**
 * @openapi
 * /api/sessions/{session_id}/commentaries/draft:
 *   delete:
 *     summary: Discard a session's draft commentary
 *     tags: [Session Commentaries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: session_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       204:
 *         description: Draft discarded
 *       404:
 *         description: Session not found, or it has no draft
 */
router.delete(
    '/draft',
    requirePermission(PERMS.SESSION_COMMENTARIES_WRITE_OWN_CLINIC),
    sessionIdValidation,
    validateRequest,
    sessionCommentaryController.deleteDraftCommentary
)

/**
 * @openapi
 * /api/sessions/{session_id}/commentaries/{commentary_id}:
 *   get:
 *     summary: Get one version of a session's commentary
 *     description: Any version, including superseded ones and the draft.
 *     tags: [Session Commentaries]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: session_id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: commentary_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The commentary version
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/SessionCommentary' }
 *       404:
 *         description: Session not found, or the commentary does not belong to this session
 */
// Registered last so /active and /draft are matched before this parameter route.
router.get(
    '/:commentary_id',
    requirePermission(PERMS.SESSION_COMMENTARIES_READ_OWN_CLINIC),
    commentaryIdValidation,
    validateRequest,
    sessionCommentaryController.getCommentaryById
)

export default router
