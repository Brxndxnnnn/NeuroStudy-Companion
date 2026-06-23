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
 *           description: Comma-separated list of language codes (e.g., "en,ms,cn")
 *     responses:
 *       200:
 *         description: Array of questions
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
 *           description: Comma-separated list of language codes (e.g., "en,ms,cn")
 *     responses:
 *       200:
 *         description: Array of questions for the specified questionnaire
 *       404:
 *         description: No questions found for the given questionnaire_id
 */
router.get('/:questionnaire_id/questions', questionnaireController.getQuestionsByQuestionnaireId)

export default router