import questionModel from '../models/question.model.js'
import catchAsync  from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

// ── GET /api/questions ─────────────────────────────────────────────────────────
const listQuestions = catchAsync(async (req, res) => {
    const questions = await questionModel.findAll(req.dbClient)
    return res.json(questions)
})

// ── GET /api/questions/:question_id ─────────────────────────────────────────────
const getQuestionById = catchAsync(async (req, res) => {
    const { question_id } = req.params
    if (!question_id)
        throw new BadRequestError('Missing required field: question_id is required')
    const results = await questionModel.findById(question_id, req.dbClient)
    if (!results || results.length === 0)
        throw new NotFoundError('Question not found')
    return res.json(results[0])
})

export default { listQuestions, getQuestionById }