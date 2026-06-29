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

export default router