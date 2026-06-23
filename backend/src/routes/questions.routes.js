import { Router } from 'express'
import questionController from '../controllers/question.controller.js'

const router = Router()

/**
 * @openapi
 * /api/questions:
 *   get:
 *     summary: Retrieve a list of all questions
 *     description: |
 *       This endpoint retrieves a list of all questions available in the system.
 *     tags: [Questions]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: A list of questions
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
 *                   question_no:
 *                     type: integer
 *                   prompt:
 *                     type: string
 *                   correct_answer:
 *                     type: string
 *                   difficulty:
 *                     type: string
 *                   created_at:
 *                     type: string
 *                     format: date-time
 */
router.get(
    '/',
    questionController.listQuestions
)

/**
 * @openapi
 * /api/questions/{question_id}:
 *   get:
 *     summary: Retrieve a specific question by its ID
 *     description: |
 *       This endpoint retrieves a specific question based on the provided question_id.
 *     tags: [Questions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: question_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The unique identifier of the question
 *     responses:
 *       200:
 *         description: A specific question
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
 *                   question_no:
 *                     type: integer
 *                   prompt:
 *                     type: string
 *                   correct_answer:
 *                     type: string
 *                   difficulty:
 *                     type: string
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *               
 *       400:
 *         description: Invalid question_id format
 *       404:
 *         description: Question not found
 */
router.get(
    '/:question_id',
    questionController.getQuestionById
)

export default router