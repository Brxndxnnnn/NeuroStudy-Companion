import { Router } from 'express'
import questionnaireController from '../controllers/questionnaire.controller.js'
import requirePermission from '../middleware/requirePermission.js'
import validateRequest from '../middleware/validateRequest.js'
import { answerQuestionnaireValidation, questionnaireIdValidation } from '../validators/questionnaire.validators.js'
import PERMS from '../constants/permissions.js'

const router = Router()

/**
 * @openapi
 * /api/questionnaires:
 *   get:
 *     summary: List all questionnaires in presentation order (BFI-2, then WHO-5)
 *     description: |
 *       Each questionnaire includes its `code` (`bfi2`, `who5`), answer scale
 *       (`scale_min`/`scale_max`), `options` (answer labels per value, per language, in
 *       display order) and `instructions` (intro and optional stem, per language).
 *     tags: [Questionnaires]
 *     responses:
 *       200:
 *         description: Array of questionnaires
 */
router.get('/', questionnaireController.listQuestionnaires)

/**
 * @openapi
 * /api/questionnaires/{questionnaire_id}:
 *   get:
 *     summary: Get a specific questionnaire by its ID
 *     tags: [Questionnaires]
 *     parameters:
 *       - in: path
 *         name: questionnaire_id
 *         required: true
 *     responses:
 *       200:
 *         description: Questionnaire found
 *       404:
 *         description: Questionnaire not found
 */
router.get(
    '/:questionnaire_id',
    questionnaireIdValidation,
    validateRequest,
    questionnaireController.getQuestionnaireById
)

/**
 * @openapi
 * /api/questionnaires/{questionnaire_id}/questions:
 *   get:
 *     summary: List all questions for a specific questionnaire, optionally filtered by languages
 *     tags: [Questionnaires]
 *     parameters:
 *       - in: path
 *         name: questionnaire_id
 *         required: true
 *       - in: query
 *         name: languages
 *         schema:
 *           type: string
 *           description: Comma-separated list of language codes (e.g., "en,ms,zh")
 *     responses:
 *       200:
 *         description: Array of questions for the specified questionnaire
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   question_id:
 *                     type: string
 *                     format: uuid
 *                     example: "750c4551-2932-4597-bf72-27050e318795"
 *                   question_no:
 *                     type: integer
 *                     example: 1
 *                   domain:
 *                     type: string
 *                     nullable: true
 *                     description: "BFI-2 personality domain (E, A, C, N, O); null for WHO-5"
 *                     example: "E"
 *                   facet:
 *                     type: string
 *                     nullable: true
 *                     description: "BFI-2 facet; null for WHO-5"
 *                     example: "Sociability"
 *                   is_reverse_scored:
 *                     type: boolean
 *                     example: false
 *                   statement:
 *                     type: object
 *                     description: "Multi-language statements (JSONB), returned when `languages` is omitted"
 *                     additionalProperties:
 *                       type: string
 *                     example:
 *                       en: "Is outgoing, sociable"
 *                       ms: "Bersikap peramah dan suka bergaul"
 *                       zh: "外向、善于社交"
 *       400:
 *         description: Invalid questionnaire_id or language code
 *       404:
 *         description: No questions found for the given questionnaire_id
 */
router.get(
    '/:questionnaire_id/questions',
    questionnaireIdValidation,
    validateRequest,
    questionnaireController.getQuestionsByQuestionnaireId
)

/**
 * @openapi
 * /api/questionnaires/answer:
 *   post:
 *     summary: Submit answers for a questionnaire
 *     description: |
 *       Submits one questionnaire for a completed session. The submission must answer every
 *       question of the questionnaire exactly once, each with a whole number within its
 *       scale (BFI-2 1-5, WHO-5 0-5). A questionnaire can only be submitted once per session.
 *       All answers are saved together or not at all.
 *
 *       **Note on Clinic ID:** the frontend does NOT send a `clinic_id`. The database takes
 *       it from the session.
 *
 *       The response includes the questionnaire's scores (see
 *       `GET /api/sessions/{session_id}/questionnaires` for their shape).
 *     tags: [Questionnaires]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               session_id:
 *                 type: string
 *                 format: uuid
 *                 example: "123e4567-e89b-12d3-a456-426614174000"
 *               questionnaire_id:
 *                 type: string
 *                 format: uuid
 *                 example: "750c4551-2932-4597-bf72-27050e318795"
 *               answers:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     question_id:
 *                       type: string
 *                       format: uuid
 *                       example: "750c4551-2932-4597-bf72-27050e318795"
 *                     answer_value:
 *                       type: integer
 *                       example: 4
 *     responses:
 *       201:
 *         description: 1 answer(s) submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "1 answer(s) submitted successfully"
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       session_id:
 *                         type: string
 *                         format: uuid
 *                       questionnaire_id:
 *                         type: string
 *                         format: uuid
 *                       question_id:
 *                         type: string
 *                         format: uuid
 *                       response_value:
 *                         type: integer
 *                       clinic_id:
 *                         type: string
 *                         format: uuid
 *                 scores:
 *                   type: object
 *                   description: "{ total, domains, facets } for this questionnaire"
 *       400:
 *         description: Missing, extra, duplicate or out-of-range answers; the message lists each problem
 *       404:
 *         description: Session or questionnaire not found
 *       409:
 *         description: The session has not completed, or this questionnaire was already submitted for it
 */
router.post(
    '/answer',
    requirePermission(PERMS.SESSIONS_WRITE_OWN_CLINIC),
    answerQuestionnaireValidation,
    validateRequest,
    questionnaireController.answerQuestionnaire
)

export default router