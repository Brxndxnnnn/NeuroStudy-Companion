import { param } from 'express-validator'
import { BadRequestError } from '../utils/AppError.js'

// Mirrors the report sections in db/migrations/023_session_commentaries.sql, in report order.
export const COMMENTARY_TEXT_FIELDS = Object.freeze([
    'anamnesis',
    'eeg_premeasurement',
    'eeg_eyes_closed',
    'eeg_eyes_open',
    'eeg_cognitive_task',
    'eeg_conclusion',
    'prognostic_estimation'
])

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const sessionIdValidation = [
    param('session_id')
        .matches(UUID_SHAPE)
        .withMessage('session_id must be a valid UUID-formatted identifier')
]

export const commentaryIdValidation = [
    ...sessionIdValidation,
    param('commentary_id')
        .matches(UUID_SHAPE)
        .withMessage('commentary_id must be a valid UUID-formatted identifier')
]

/**
 * Validates and normalizes a session commentary. With requireComplete, every section
 * must contain text, which is what publishing needs; drafts may leave sections empty.
 * Blank or whitespace-only text becomes null, matching the database's completeness
 * check. Returns the normalized commentary or throws BadRequestError listing every problem.
 */
export const validateSessionCommentary = (commentary, { requireComplete }) => {
    if (!commentary || typeof commentary !== 'object' || Array.isArray(commentary))
        throw new BadRequestError('Session commentary is invalid. commentary: must be an object')

    const errors = []
    const normalized = {}

    for (const field of COMMENTARY_TEXT_FIELDS) {
        const value = commentary[field]
        if (value === undefined || value === null) {
            normalized[field] = null
        } else if (typeof value !== 'string') {
            errors.push(`${field}: must be a string`)
            normalized[field] = null
            continue
        } else {
            const trimmed = value.trim()
            normalized[field] = trimmed === '' ? null : trimmed
        }

        if (requireComplete && normalized[field] === null)
            errors.push(`${field}: is required`)
    }

    if (errors.length > 0)
        throw new BadRequestError(`Session commentary is invalid. ${errors.join(', ')}`)

    return normalized
}
