import questionModel from '../models/question.model.js'
import catchAsync  from '../utils/catchAsync.js'

// ── GET /api/questions ─────────────────────────────────────────────────────────
const listQuestions = catchAsync(async (req, res) => {
    const questions = await questionModel.findAll(req.dbClient)
    return res.json(questions)
})

// ── GET /api/questions/:question_id ─────────────────────────────────────────────
const getQuestionById = catchAsync(async (req, res) => {
    const { question_id } = req.params
    let results

    try {
        results = await questionModel.findById(question_id, req.dbClient)
    } catch (err) {
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid question_id format' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    }

    if (!results || results.length === 0) {
        return res.status(404).json({ error: 'Question not found' })
    }

    return res.json(results[0])
})

export default { listQuestions, getQuestionById }