import questionnaireModel from '../models/questionnaire.model.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

// ── GET /api/questionnaires ─────────────────────────────────────────────────────
const listQuestionnaires = catchAsync(async (req, res) => {
    const questionnaires = await questionnaireModel.findAll(req.dbClient)
    return res.json(questionnaires)
})

// ── GET /api/questionnaires/:questionnaire_id ─────────────────────────────────
const getQuestionnaireById = catchAsync(async (req, res) => {
    const { questionnaire_id } = req.params
    if (!questionnaire_id)
        throw new BadRequestError('Missing required field: questionnaire_id is required')
    const results = await questionnaireModel.findById(questionnaire_id, req.dbClient)
    if (!results || results.length === 0)
        throw new NotFoundError('Questionnaire not found')

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
    if (!questionnaire_id)
        throw new BadRequestError('Missing required field: questionnaire_id is required')

    const languages = req.query.languages ? req.query.languages.split(',') : []
    const validLanguages = ['en', 'ms', 'zh']
    if (languages.some(lang => !validLanguages.includes(lang)))
        throw new BadRequestError(`Invalid language code(s). Valid codes are: ${validLanguages.join(', ')}`)
    
    const results = await questionnaireModel.findQuestionsByQuestionnaireId(questionnaire_id, languages, req.dbClient)
    if (!results || results.length === 0)
        throw new NotFoundError('No questions found for the given questionnaire_id')

    return res.json(results)
})
// ── POST /api/questionnaires/answer ─────────────────────────────────────────────
const answerQuestionnaire = catchAsync(async (req, res) => {
    const { session_id, questionnaire_id, answers } = req.body
    if (!session_id || !questionnaire_id || !answers || !Array.isArray(answers) || answers.length === 0)
        throw new BadRequestError('Missing required fields: session_id, questionnaire_id, and answers are required')
    const results = await questionnaireModel.insertAnswers(session_id, questionnaire_id, answers, req.user.clinic_id, req.dbClient)
    return res.status(201).json({ message: results.length + ' answer(s) submitted successfully', results })
})

export default { listQuestionnaires, getQuestionnaireById, listAllQuestions, getQuestionsByQuestionnaireId, answerQuestionnaire }