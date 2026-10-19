import questionnaireModel from '../models/questionnaire.model.js'
import sessionModel from '../models/session.model.js'
import catchAsync from '../utils/catchAsync.js'
import { ConflictError, NotFoundError } from '../utils/AppError.js'
import { BFI2_DOMAIN_NAMES, parseLanguages, validateAnswers } from '../validators/questionnaire.validators.js'

const DOMAIN_ORDER = Object.keys(BFI2_DOMAIN_NAMES)

const pickScore = row => ({
    raw_score: row.raw_score,
    mean_score: row.mean_score,
    percentage_score: row.percentage_score,
    answered_items: row.answered_items,
    expected_items: row.expected_items,
    is_complete: row.is_complete
})

// Groups one questionnaire's rows from session_questionnaire_scores into
// { total, domains, facets }. WHO-5 only has a total; BFI-2 also has domains and facets.
const summarizeScores = rows => ({
    total: rows.filter(r => r.score_level === 'total').map(pickScore)[0] ?? null,
    domains: rows
        .filter(r => r.score_level === 'domain')
        .sort((a, b) => DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain))
        .map(r => ({ domain: r.domain, domain_name: BFI2_DOMAIN_NAMES[r.domain] ?? null, ...pickScore(r) })),
    facets: rows
        .filter(r => r.score_level === 'facet')
        .sort((a, b) => DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain) || a.facet.localeCompare(b.facet))
        .map(r => ({ domain: r.domain, facet: r.facet, ...pickScore(r) }))
})

// ── GET /api/questionnaires ─────────────────────────────────────────────────────
const listQuestionnaires = catchAsync(async (req, res) => {
    const questionnaires = await questionnaireModel.findAll(req.dbClient)
    return res.json(questionnaires)
})

// ── GET /api/questionnaires/:questionnaire_id ─────────────────────────────────
const getQuestionnaireById = catchAsync(async (req, res) => {
    const { questionnaire_id } = req.validated
    const results = await questionnaireModel.findById(questionnaire_id, req.dbClient)
    if (!results || results.length === 0)
        throw new NotFoundError('Questionnaire not found')

    return res.json(results[0])
})

// ── GET /api/questionnaires/:questionnaire_id/questions ─────────────────────────
const getQuestionsByQuestionnaireId = catchAsync(async (req, res) => {
    const { questionnaire_id } = req.validated
    const languages = parseLanguages(req.query.languages)

    const results = await questionnaireModel.findQuestionsByQuestionnaireId(questionnaire_id, languages, req.dbClient)
    if (!results || results.length === 0)
        throw new NotFoundError('No questions found for the given questionnaire_id')

    return res.json(results)
})

// ── POST /api/questionnaires/answer ─────────────────────────────────────────────
// One questionnaire per request, answered once per session, complete and in range.
const answerQuestionnaire = catchAsync(async (req, res) => {
    const { session_id, questionnaire_id } = req.validated
    const { answers } = req.body

    // RLS hides other clinics' sessions, so "not found" also covers "not yours".
    const sessions = await sessionModel.findById(session_id, req.dbClient)
    if (!sessions || sessions.length === 0)
        throw new NotFoundError('Session not found')
    if (sessions[0].sync_status !== 'completed')
        throw new ConflictError('Questionnaires can only be answered after the session has completed')

    const questionnaires = await questionnaireModel.findById(questionnaire_id, req.dbClient)
    if (!questionnaires || questionnaires.length === 0)
        throw new NotFoundError('Questionnaire not found')
    const questionnaire = questionnaires[0]

    const questions = await questionnaireModel.findQuestionsByQuestionnaireId(questionnaire_id, [], req.dbClient)
    const validAnswers = validateAnswers(answers, questions.map(q => q.question_id), questionnaire)

    // Checked up front for a clear message; UNIQUE (session_id, question_id) still
    // rejects a concurrent duplicate (409 via the 23505 mapping).
    if (await questionnaireModel.hasAnswers(session_id, questionnaire_id, req.dbClient))
        throw new ConflictError('This questionnaire has already been submitted for this session')

    const results = await questionnaireModel.insertAnswers(session_id, questionnaire_id, validAnswers, req.dbClient)
    const scores = await questionnaireModel.findSessionScores(session_id, questionnaire_id, req.dbClient)

    return res.status(201).json({
        message: results.length + ' answer(s) submitted successfully',
        results,
        scores: summarizeScores(scores)
    })
})

// ── GET /api/sessions/:session_id/questionnaires ──────────────────────────────────
// Every questionnaire (answered or not) with the session's answers and scores, for the
// results page and later the PDF report.
const getSessionQuestionnaires = catchAsync(async (req, res) => {
    const { session_id } = req.validated

    const sessions = await sessionModel.findById(session_id, req.dbClient)
    if (!sessions || sessions.length === 0)
        throw new NotFoundError('Session not found')

    const [questionnaires, answers, scores] = await Promise.all([
        questionnaireModel.listWithItemCounts(req.dbClient),
        questionnaireModel.findSessionAnswers(session_id, req.dbClient),
        questionnaireModel.findSessionScores(session_id, null, req.dbClient)
    ])

    const result = questionnaires.map(q => {
        const qAnswers = answers.filter(a => a.questionnaire_id === q.questionnaire_id)
        const summary = summarizeScores(scores.filter(s => s.questionnaire_id === q.questionnaire_id))
        const submittedAt = qAnswers.reduce((latest, a) => (!latest || a.created_at > latest ? a.created_at : latest), null)
        return {
            questionnaire_id: q.questionnaire_id,
            code: q.code,
            name: q.name,
            scale_min: q.scale_min,
            scale_max: q.scale_max,
            expected_items: q.expected_items,
            answered_items: qAnswers.length,
            is_complete: qAnswers.length > 0 && qAnswers.length === q.expected_items,
            submitted_at: submittedAt,
            scores: qAnswers.length > 0 ? summary : null,
            answers: qAnswers.map(a => ({
                question_id: a.question_id,
                question_no: a.question_no,
                statement: a.statement,
                domain: a.domain,
                facet: a.facet,
                is_reverse_scored: a.is_reverse_scored,
                answer_value: a.answer_value,
                item_score: a.item_score
            }))
        }
    })

    return res.json(result)
})

export default {
    listQuestionnaires,
    getQuestionnaireById,
    getQuestionsByQuestionnaireId,
    answerQuestionnaire,
    getSessionQuestionnaires
}
