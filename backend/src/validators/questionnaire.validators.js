import { body, param } from 'express-validator'
import { BadRequestError } from '../utils/AppError.js'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Statement languages stored in questionnaire_questions.statement.
export const STATEMENT_LANGUAGES = Object.freeze(['en', 'ms', 'zh'])

// BFI-2 domains are stored as letters (db/migrations/024_bfi2_who5_questionnaires.sql).
export const BFI2_DOMAIN_NAMES = Object.freeze({
    E: 'Extraversion',
    A: 'Agreeableness',
    C: 'Conscientiousness',
    N: 'Negative Emotionality',
    O: 'Open-Mindedness'
})

export const questionnaireIdValidation = [
    param('questionnaire_id')
        .matches(UUID_SHAPE)
        .withMessage('questionnaire_id must be a valid UUID-formatted identifier')
]

export const sessionIdValidation = [
    param('session_id')
        .matches(UUID_SHAPE)
        .withMessage('session_id must be a valid UUID-formatted identifier')
]

export const answerQuestionnaireValidation = [
    body('session_id')
        .matches(UUID_SHAPE)
        .withMessage('session_id must be a valid UUID-formatted identifier'),
    body('questionnaire_id')
        .matches(UUID_SHAPE)
        .withMessage('questionnaire_id must be a valid UUID-formatted identifier'),
    body('answers')
        .isArray({ min: 1 })
        .withMessage('answers must be a non-empty array')
]

// Parses ?languages=en,zh. Returns [] (meaning "every language") when absent.
export const parseLanguages = raw => {
    if (raw === undefined || raw === '')
        return []
    const languages = [...new Set(String(raw).split(',').map(l => l.trim()).filter(Boolean))]
    const invalid = languages.filter(l => !STATEMENT_LANGUAGES.includes(l))
    if (invalid.length > 0)
        throw new BadRequestError(`Invalid language code(s): ${invalid.join(', ')}. Valid codes are: ${STATEMENT_LANGUAGES.join(', ')}`)
    return languages
}

/**
 * Checks a submission is exactly one whole-number answer per question of the
 * questionnaire, each within its scale. The database trigger enforces the range too;
 * this gives a single 400 listing every problem instead of failing on the first row.
 *
 * Returns [{ question_id, answer_value }] or throws BadRequestError.
 */
export const validateAnswers = (answers, questionIds, { scale_min, scale_max }) => {
    const errors = []
    const expected = new Set(questionIds)
    const seen = new Set()
    const normalized = []

    answers.forEach((answer, index) => {
        const path = `answers[${index}]`
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
            errors.push(`${path}: must be an object`)
            return
        }
        const questionId = typeof answer.question_id === 'string' ? answer.question_id.toLowerCase() : answer.question_id
        if (!expected.has(questionId)) {
            errors.push(`${path}.question_id: is not a question of this questionnaire`)
            return
        }
        if (seen.has(questionId)) {
            errors.push(`${path}.question_id: is answered more than once`)
            return
        }
        seen.add(questionId)
        const value = answer.answer_value
        if (!Number.isInteger(value) || value < scale_min || value > scale_max) {
            errors.push(`${path}.answer_value: must be a whole number between ${scale_min} and ${scale_max}`)
            return
        }
        normalized.push({ question_id: questionId, answer_value: value })
    })

    const missing = questionIds.filter(id => !seen.has(id)).length
    if (missing > 0)
        errors.push(`answers: ${missing} of ${questionIds.length} questions are not answered`)

    if (errors.length > 0)
        throw new BadRequestError(`Questionnaire answers are invalid. ${errors.join(', ')}`)

    return normalized
}
