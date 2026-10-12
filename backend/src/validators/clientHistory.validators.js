import { param } from 'express-validator'
import { BadRequestError } from '../utils/AppError.js'

// Mirrors the CHECK constraints in db/migrations/022_client_histories.sql. Keep the
// lists in the same order as the questionnaire; responses are sorted by them.
export const HISTORY_TEXT_FIELDS = Object.freeze([
    'medical_history',
    'cognitive_behavioural_profile',
    'language_communication',
    'social_observations',
    'treatment_goals',
    'school_education',
    'occupation',
    'hobbies'
])

export const COMPLAINTS = Object.freeze([
    'headache', 'medication', 'sleep_quality', 'concentration', 'motor_activity', 'pain'
])

export const COMPLAINT_SEVERITIES = Object.freeze([
    'not_affected', 'little_affected', 'strongly_affected'
])

export const SYMPTOMS = Object.freeze([
    'concentration', 'motivation', 'social_skills'
])

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

export const clientIdValidation = [
    param('client_id')
        .matches(UUID_SHAPE)
        .withMessage('client_id must be a valid UUID-formatted identifier')
]

export const historyIdValidation = [
    ...clientIdValidation,
    param('history_id')
        .matches(UUID_SHAPE)
        .withMessage('history_id must be a valid UUID-formatted identifier')
]

// Blank strings become null so drafts store "not answered yet" consistently and the
// completeness check treats whitespace-only text as missing, like the database does.
const optionalText = (value, path, errors) => {
    if (value === undefined || value === null)
        return null
    if (typeof value !== 'string') {
        errors.push(`${path}: must be a string`)
        return null
    }
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
}

const isValidDate = value => {
    if (typeof value !== 'string' || !DATE_SHAPE.test(value))
        return false
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const normalizeAnswers = (items, path, { names, nameField, normalizeItem }, errors) => {
    if (items === undefined || items === null)
        return []
    if (!Array.isArray(items)) {
        errors.push(`${path}: must be an array`)
        return []
    }

    const seen = new Set()
    const answers = []
    items.forEach((item, index) => {
        const itemPath = `${path}[${index}]`
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push(`${itemPath}: must be an object`)
            return
        }
        const name = item[nameField]
        if (!names.includes(name)) {
            errors.push(`${itemPath}.${nameField}: must be one of ${names.join(', ')}`)
            return
        }
        if (seen.has(name)) {
            errors.push(`${itemPath}.${nameField}: ${name} is listed more than once`)
            return
        }
        seen.add(name)
        const answer = normalizeItem(item, itemPath)
        if (answer)
            answers.push({ [nameField]: name, ...answer })
    })

    answers.sort((a, b) => names.indexOf(a[nameField]) - names.indexOf(b[nameField]))
    return answers
}

/**
 * Validates and normalizes a client history payload (fields plus complaints and
 * symptoms). With requireComplete, every field and every complaint/symptom must be
 * present, which is what publishing (and client registration) needs. Without it,
 * missing values are allowed for drafts, but anything supplied must still be valid.
 *
 * Returns the normalized history or throws BadRequestError listing every problem.
 */
export const validateClientHistory = (history, { requireComplete }) => {
    const errors = []

    if (!history || typeof history !== 'object' || Array.isArray(history))
        throw new BadRequestError('Client history is invalid. history: must be an object')

    const normalized = {}

    if (history.intake_date === undefined || history.intake_date === null || history.intake_date === '') {
        normalized.intake_date = null
    } else if (!isValidDate(history.intake_date)) {
        errors.push('intake_date: must be a valid date in YYYY-MM-DD format')
        normalized.intake_date = null
    } else {
        normalized.intake_date = history.intake_date
    }

    for (const field of HISTORY_TEXT_FIELDS)
        normalized[field] = optionalText(history[field], field, errors)

    normalized.complaints = normalizeAnswers(history.complaints, 'complaints', {
        names: COMPLAINTS,
        nameField: 'complaint',
        normalizeItem: (item, itemPath) => {
            if (!COMPLAINT_SEVERITIES.includes(item.severity)) {
                errors.push(`${itemPath}.severity: must be one of ${COMPLAINT_SEVERITIES.join(', ')}`)
                return null
            }
            return {
                severity: item.severity,
                comment: optionalText(item.comment, `${itemPath}.comment`, errors)
            }
        }
    }, errors)

    normalized.symptoms = normalizeAnswers(history.symptoms, 'symptoms', {
        names: SYMPTOMS,
        nameField: 'symptom',
        normalizeItem: (item, itemPath) => {
            if (!Number.isInteger(item.rating) || item.rating < 1 || item.rating > 10) {
                errors.push(`${itemPath}.rating: must be an integer between 1 and 10`)
                return null
            }
            return {
                rating: item.rating,
                notes: optionalText(item.notes, `${itemPath}.notes`, errors)
            }
        }
    }, errors)

    if (requireComplete) {
        if (!normalized.intake_date && !errors.some(e => e.startsWith('intake_date')))
            errors.push('intake_date: is required')
        for (const field of HISTORY_TEXT_FIELDS) {
            if (!normalized[field] && !errors.some(e => e.startsWith(`${field}:`)))
                errors.push(`${field}: is required`)
        }
        const answered = new Set(normalized.complaints.map(c => c.complaint))
        const missingComplaints = COMPLAINTS.filter(c => !answered.has(c))
        if (missingComplaints.length > 0)
            errors.push(`complaints: missing ${missingComplaints.join(', ')}`)
        const rated = new Set(normalized.symptoms.map(s => s.symptom))
        const missingSymptoms = SYMPTOMS.filter(s => !rated.has(s))
        if (missingSymptoms.length > 0)
            errors.push(`symptoms: missing ${missingSymptoms.join(', ')}`)
    }

    if (errors.length > 0)
        throw new BadRequestError(`Client history is invalid. ${errors.join(', ')}`)

    return normalized
}
