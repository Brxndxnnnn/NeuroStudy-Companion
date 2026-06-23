import questionnaireModel from '../models/questionnaire.model.js'
import catchAsync from '../utils/catchAsync.js'

// ── GET /api/questionnaires ─────────────────────────────────────────────────────
const listQuestionnaires = catchAsync(async (req, res) => {
    const questionnaires = await questionnaireModel.findAll(req.dbClient)
    return res.json(questionnaires)
})

// ── GET /api/questionnaires/:questionnaire_id ─────────────────────────────────
const getQuestionnaireById = catchAsync(async (req, res) => {
    const { questionnaire_id } = req.params
    let results

    try {
        results = await questionnaireModel.findById(questionnaire_id, req.dbClient)
    } catch (err) {
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid questionnaire_id format' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    }

    if (!results || results.length === 0) {
        return res.status(404).json({ error: 'Questionnaire not found' })
    }

    return res.json(results[0])
})

// ── GET /api/questionnaires/questions ──────────────────────────────────────────
const listAllQuestions = catchAsync(async (req, res) => {
    const languages = req.query.languages ? req.query.languages.split(',') : []
    const questions = await questionnaireModel.findAllQuestions(languages, req.dbClient)
    return res.json(questions)
})

// ── GET /api/questionnaires/:questionnaire_id/questions ─────────────────────────
const getQuestionsByQuestionnaireId = catchAsync(async (req, res) => {
    const { questionnaire_id } = req.params
    const languages = req.query.languages ? req.query.languages.split(',') : []
    console.log('Requested languages:', languages)
    console.log('Requested questionnaire_id:', questionnaire_id)
    let results

    try {
        results = await questionnaireModel.findQuestionsByQuestionnaireId(questionnaire_id, languages, req.dbClient)
    } catch (err) {
        console.error('Error fetching questions by questionnaire_id:', err)
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid questionnaire_id format' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    }

    if (!results || results.length === 0) {
        return res.status(404).json({ error: 'No questions found for the given questionnaire_id' })
    }

    return res.json(results)
})

export default { listQuestionnaires, getQuestionnaireById, listAllQuestions, getQuestionsByQuestionnaireId }