import { Router } from 'express'
import clientHistoryController from '../controllers/clientHistory.controller.js'
import requirePermission from '../middleware/requirePermission.js'
import validateRequest from '../middleware/validateRequest.js'
import { clientIdValidation, historyIdValidation } from '../validators/clientHistory.validators.js'
import PERMS from '../constants/permissions.js'

// Mounted at /api/clients/:client_id/histories; mergeParams exposes :client_id.
const router = Router({ mergeParams: true })

/**
 * @openapi
 * components:
 *   schemas:
 *     ClientHistoryInput:
 *       type: object
 *       description: |
 *         All fields are required when publishing or registering a client. Drafts may
 *         omit any of them. Complaints and symptoms are each listed at most once.
 *       example:
 *         intake_date: "2026-10-13"
 *         medical_history: "History of early learning difficulties; no major surgeries or rehabilitation stays."
 *         cognitive_behavioural_profile: "Distractible and fidgety; needs extra time to process information."
 *         language_communication: "Right-hand dominant; stronger in English than other languages."
 *         social_observations: "Social engagement present but limited; shy with unfamiliar people."
 *         treatment_goals: "Improve attention and focus during tasks."
 *         school_education: "Currently in private school"
 *         occupation: "-"
 *         hobbies: "Cycling and reading comics"
 *         complaints:
 *           - { complaint: headache,       severity: not_affected,      comment: "" }
 *           - { complaint: medication,     severity: not_affected,      comment: "" }
 *           - { complaint: sleep_quality,  severity: strongly_affected, comment: "Sleeps around 12-1 a.m." }
 *           - { complaint: concentration,  severity: little_affected,   comment: "Focus depends on interest." }
 *           - { complaint: motor_activity, severity: not_affected,      comment: "" }
 *           - { complaint: pain,           severity: not_affected,      comment: "" }
 *         symptoms:
 *           - { symptom: concentration, rating: 5, notes: "" }
 *           - { symptom: motivation,    rating: 6, notes: "Depends on interest" }
 *           - { symptom: social_skills, rating: 4, notes: "Very shy with unfamiliar people" }
 *       properties:
 *         intake_date:                   { type: string, format: date, example: "2026-10-13" }
 *         medical_history:               { type: string }
 *         cognitive_behavioural_profile: { type: string }
 *         language_communication:        { type: string }
 *         social_observations:           { type: string }
 *         treatment_goals:               { type: string }
 *         school_education:              { type: string }
 *         occupation:                    { type: string }
 *         hobbies:                       { type: string }
 *         complaints:
 *           type: array
 *           description: One entry per complaint; all six are required to publish.
 *           items:
 *             type: object
 *             required: [complaint, severity]
 *             properties:
 *               complaint: { type: string, enum: [headache, medication, sleep_quality, concentration, motor_activity, pain] }
 *               severity:  { type: string, enum: [not_affected, little_affected, strongly_affected] }
 *               comment:   { type: string }
 *         symptoms:
 *           type: array
 *           description: One entry per symptom; all three are required to publish.
 *           items:
 *             type: object
 *             required: [symptom, rating]
 *             properties:
 *               symptom: { type: string, enum: [concentration, motivation, social_skills] }
 *               rating:  { type: integer, minimum: 1, maximum: 10 }
 *               notes:   { type: string }
 *     ClientHistory:
 *       allOf:
 *         - $ref: '#/components/schemas/ClientHistoryInput'
 *         - type: object
 *           properties:
 *             history_id:   { type: string, format: uuid }
 *             client_id:    { type: string, format: uuid }
 *             clinic_id:    { type: string, format: uuid }
 *             version:      { type: integer, nullable: true, description: "Null while draft" }
 *             status:       { type: string, enum: [draft, active, superseded] }
 *             is_backfilled_default:
 *               type: boolean
 *               description: True for the placeholder history given to clients that existed before histories were introduced.
 *             created_by:   { type: string, format: uuid, nullable: true }
 *             created_at:   { type: string, format: date-time }
 *             updated_at:   { type: string, format: date-time }
 *             published_by: { type: string, format: uuid, nullable: true }
 *             published_at: { type: string, format: date-time, nullable: true }
 *     ClientHistorySummary:
 *       type: object
 *       properties:
 *         history_id:   { type: string, format: uuid }
 *         version:      { type: integer, nullable: true, description: "Null while draft" }
 *         status:       { type: string, enum: [draft, active, superseded] }
 *         intake_date:  { type: string, format: date, nullable: true }
 *         is_backfilled_default: { type: boolean }
 *         created_by:   { type: string, format: uuid, nullable: true }
 *         created_at:   { type: string, format: date-time }
 *         updated_at:   { type: string, format: date-time }
 *         published_by: { type: string, format: uuid, nullable: true }
 *         published_at: { type: string, format: date-time, nullable: true }
 */

/**
 * @openapi
 * /api/clients/{client_id}/histories:
 *   get:
 *     summary: List every version of a client's history
 *     description: |
 *       Newest first, with the draft (if any) at the top. Answers are not included;
 *       fetch a version by ID for its complaints and symptoms.
 *     tags: [Client Histories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: client_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The client's history versions
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/ClientHistorySummary' }
 *       404:
 *         description: Client not found
 */
router.get(
    '/',
    requirePermission(PERMS.CLIENT_HISTORIES_READ_OWN_CLINIC),
    clientIdValidation,
    validateRequest,
    clientHistoryController.listHistories
)

/**
 * @openapi
 * /api/clients/{client_id}/histories/active:
 *   get:
 *     summary: Get a client's published (active) history
 *     tags: [Client Histories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: client_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The active history with its complaints and symptoms
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ClientHistory' }
 *       404:
 *         description: Client not found, or it has no published history
 */
router.get(
    '/active',
    requirePermission(PERMS.CLIENT_HISTORIES_READ_OWN_CLINIC),
    clientIdValidation,
    validateRequest,
    clientHistoryController.getActiveHistory
)

/**
 * @openapi
 * /api/clients/{client_id}/histories/draft:
 *   get:
 *     summary: Get a client's draft history
 *     tags: [Client Histories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: client_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The draft with whatever answers have been saved
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ClientHistory' }
 *       404:
 *         description: Client not found, or it has no draft
 */
router.get(
    '/draft',
    requirePermission(PERMS.CLIENT_HISTORIES_READ_OWN_CLINIC),
    clientIdValidation,
    validateRequest,
    clientHistoryController.getDraftHistory
)

/**
 * @openapi
 * /api/clients/{client_id}/histories/draft:
 *   put:
 *     summary: Create or replace a client's draft history
 *     description: |
 *       Saves the whole draft: fields not supplied are cleared, and the complaints and
 *       symptoms sent replace any saved before. Incomplete drafts are allowed. To edit
 *       a published history, load it from /active and save it here as a new draft.
 *     tags: [Client Histories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: client_id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ClientHistoryInput' }
 *     responses:
 *       200:
 *         description: The saved draft
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ClientHistory' }
 *       400:
 *         description: Invalid values
 *       404:
 *         description: Client not found
 */
router.put(
    '/draft',
    requirePermission(PERMS.CLIENT_HISTORIES_WRITE_OWN_CLINIC),
    clientIdValidation,
    validateRequest,
    clientHistoryController.saveDraftHistory
)

/**
 * @openapi
 * /api/clients/{client_id}/histories/draft/publish:
 *   post:
 *     summary: Publish a client's draft history
 *     description: |
 *       The draft becomes the active history with the next version number, and the
 *       previous active history is superseded. New sessions paired afterwards use it.
 *     tags: [Client Histories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: client_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The published history
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ClientHistory' }
 *       400:
 *         description: The draft is incomplete; the message lists what is missing
 *       404:
 *         description: Client not found, or it has no draft
 *       409:
 *         description: The draft was published or discarded by another request
 */
router.post(
    '/draft/publish',
    requirePermission(PERMS.CLIENT_HISTORIES_WRITE_OWN_CLINIC),
    clientIdValidation,
    validateRequest,
    clientHistoryController.publishDraftHistory
)

/**
 * @openapi
 * /api/clients/{client_id}/histories/draft:
 *   delete:
 *     summary: Discard a client's draft history
 *     tags: [Client Histories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: client_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       204:
 *         description: Draft discarded
 *       404:
 *         description: Client not found, or it has no draft
 */
router.delete(
    '/draft',
    requirePermission(PERMS.CLIENT_HISTORIES_WRITE_OWN_CLINIC),
    clientIdValidation,
    validateRequest,
    clientHistoryController.deleteDraftHistory
)

/**
 * @openapi
 * /api/clients/{client_id}/histories/{history_id}:
 *   get:
 *     summary: Get one version of a client's history
 *     description: |
 *       Any version, including superseded ones and the draft. Use this with a session's
 *       client_history_id to show the history that applied when the session was paired.
 *     tags: [Client Histories]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: path, name: client_id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: history_id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The history version with its complaints and symptoms
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ClientHistory' }
 *       404:
 *         description: Client not found, or the history does not belong to this client
 */
// Registered last so /active and /draft are matched before this parameter route.
router.get(
    '/:history_id',
    requirePermission(PERMS.CLIENT_HISTORIES_READ_OWN_CLINIC),
    historyIdValidation,
    validateRequest,
    clientHistoryController.getHistoryById
)

export default router
