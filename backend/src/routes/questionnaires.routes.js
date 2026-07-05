import { Router } from 'express'
import questionnaireController from '../controllers/questionnaire.controller.js'

const router = Router()

/**
 * @openapi
 * /api/questionnaires:
 *   get:
 *     summary: List all questionnaires
 *     tags: [Questionnaires]
 *     responses:
 *       200:
 *         description: Array of questionnaires
 */
router.get('/', questionnaireController.listQuestionnaires)


/**
 * @openapi
 * /api/questionnaires/questions:
 *   get:
 *     summary: List all questions across all questionnaires, optionally filtered by languages
 *     tags: [Questionnaires]
 *     parameters:
 *       - in: query
 *         name: languages
 *         schema:
 *           type: string
 *           description: Comma-separated list of language codes (e.g., "en,ms,zh")
 *     responses:
 *       200:
 *         description: Array of questions
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
 *                     description: "BFI-2 personality domain (E, A, C, N, O)"
 *                     example: "E"
 *                   is_reverse_scored:
 *                     type: boolean
 *                     example: false
 *                   statement:
 *                     type: object
 *                     description: "Multi-language statements (JSONB)"
 *                     additionalProperties:
 *                       type: string
 *                     example:
 *                       en: "Someone who is outgoing and comfortable interacting with others."
 *                       ms: "Seseorang yang peramah dan selesa berinteraksi dengan orang lain."
 *                       zh: "一个外向且乐于与他人交往的人。"
 */
router.get('/questions', questionnaireController.listAllQuestions)

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
router.get('/:questionnaire_id', questionnaireController.getQuestionnaireById)

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
 *                     description: "BFI-2 personality domain (E, A, C, N, O)"
 *                     example: "E"
 *                   is_reverse_scored:
 *                     type: boolean
 *                     example: false
 *                   statement:
 *                     type: object
 *                     description: "Multi-language statements (JSONB)"
 *                     additionalProperties:
 *                       type: string
 *                     example:
 *                       en: "Someone who is outgoing and comfortable interacting with others."
 *                       ms: "Seseorang yang peramah dan selesa berinteraksi dengan orang lain."
 *                       zh: "一个外向且乐于与他人交往的人。"
 *       404:
 *         description: No questions found for the given questionnaire_id
 */
router.get('/:questionnaire_id/questions', questionnaireController.getQuestionsByQuestionnaireId)

/**
 * @openapi
 * /api/questionnaires/answer:
 *   post:
 *     summary: Submit answers for a questionnaire
 *     description: Submit answers for a specific questionnaire associated with a session and clinic.
 *       
 *       **Note on Clinic ID:** 
 *       The frontend does NOT need to send the technician's `clinic_id`. 
 *       The backend automatically extracts the `clinic_id` 
 *       from the signed JWT (Bearer token) provided in the Authorization header.
 *     tags: [Questionnaires]
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
 *       400:
 *         description: Bad request (missing required fields or invalid data)
 *       409:
 *         description: Conflict (e.g., duplicate submission)
 */
router.post('/answer', questionnaireController.answerQuestionnaire)

export default router