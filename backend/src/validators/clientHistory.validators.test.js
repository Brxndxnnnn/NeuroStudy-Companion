import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { COMPLAINTS, SYMPTOMS, validateClientHistory } from './clientHistory.validators.js'
import { BadRequestError } from '../utils/AppError.js'

const completeHistory = () => ({
    intake_date: '2026-10-13',
    medical_history: 'No surgeries',
    cognitive_behavioural_profile: 'Distractible',
    language_communication: 'Right-hand dominant',
    social_observations: 'Shy with strangers',
    treatment_goals: 'Improve focus',
    school_education: 'Private school',
    occupation: '-',
    hobbies: 'Cycling',
    complaints: COMPLAINTS.map(complaint => ({ complaint, severity: 'little_affected', comment: '' })),
    symptoms: SYMPTOMS.map(symptom => ({ symptom, rating: 5 }))
})

const assertRejected = (fn, ...fragments) => {
    assert.throws(fn, err => {
        assert.ok(err instanceof BadRequestError)
        for (const fragment of fragments)
            assert.ok(err.message.includes(fragment), `expected "${fragment}" in "${err.message}"`)
        return true
    })
}

describe('validateClientHistory', () => {
    test('accepts and normalizes a complete history', () => {
        const input = completeHistory()
        input.medical_history = '  No surgeries  '
        input.complaints.reverse()

        const history = validateClientHistory(input, { requireComplete: true })

        assert.equal(history.medical_history, 'No surgeries')
        assert.deepEqual(history.complaints.map(c => c.complaint), [...COMPLAINTS])
        assert.equal(history.complaints[0].comment, null)
        assert.equal(history.symptoms[0].notes, null)
    })

    test('lists every missing item when completeness is required', () => {
        const input = completeHistory()
        delete input.hobbies
        input.occupation = '   '
        input.complaints = input.complaints.filter(c => c.complaint !== 'pain')
        input.symptoms = []

        assertRejected(
            () => validateClientHistory(input, { requireComplete: true }),
            'hobbies: is required',
            'occupation: is required',
            'complaints: missing pain',
            'symptoms: missing concentration, motivation, social_skills'
        )
    })

    test('allows a partial draft', () => {
        const history = validateClientHistory(
            { medical_history: 'Asthma', complaints: [{ complaint: 'headache', severity: 'not_affected' }] },
            { requireComplete: false }
        )
        assert.equal(history.medical_history, 'Asthma')
        assert.equal(history.hobbies, null)
        assert.equal(history.intake_date, null)
        assert.equal(history.complaints.length, 1)
        assert.deepEqual(history.symptoms, [])
    })

    test('rejects invalid values even in a draft', () => {
        assertRejected(
            () => validateClientHistory({
                intake_date: '2026-02-30',
                hobbies: 42,
                complaints: [{ complaint: 'backache', severity: 'not_affected' }],
                symptoms: [{ symptom: 'motivation', rating: 11 }]
            }, { requireComplete: false }),
            'intake_date: must be a valid date',
            'hobbies: must be a string',
            'complaints[0].complaint: must be one of',
            'symptoms[0].rating: must be an integer between 1 and 10'
        )
    })

    test('rejects duplicate complaints and symptoms', () => {
        const input = completeHistory()
        input.complaints.push({ complaint: 'headache', severity: 'strongly_affected' })
        input.symptoms.push({ symptom: 'motivation', rating: 2 })
        assertRejected(
            () => validateClientHistory(input, { requireComplete: true }),
            'headache is listed more than once',
            'motivation is listed more than once'
        )
    })

    test('rejects a history that is not an object', () => {
        assertRejected(() => validateClientHistory('none', { requireComplete: true }), 'history: must be an object')
    })
})
