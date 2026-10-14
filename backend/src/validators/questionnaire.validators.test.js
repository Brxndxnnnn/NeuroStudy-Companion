import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLanguages, validateAnswers } from './questionnaire.validators.js'
import { BadRequestError } from '../utils/AppError.js'

const Q1 = 'a0000000-0000-0000-0000-000000000001'
const Q2 = 'a0000000-0000-0000-0000-000000000002'
const WHO5_SCALE = { scale_min: 0, scale_max: 5 }

const assertRejected = (fn, ...fragments) => {
    assert.throws(fn, err => {
        assert.ok(err instanceof BadRequestError)
        for (const fragment of fragments)
            assert.ok(err.message.includes(fragment), `expected "${fragment}" in "${err.message}"`)
        return true
    })
}

describe('validateAnswers', () => {
    test('accepts one in-range answer per question, including the scale minimum', () => {
        const answers = validateAnswers(
            [{ question_id: Q1, answer_value: 0 }, { question_id: Q2.toUpperCase(), answer_value: 5 }],
            [Q1, Q2],
            WHO5_SCALE
        )
        assert.deepEqual(answers, [{ question_id: Q1, answer_value: 0 }, { question_id: Q2, answer_value: 5 }])
    })

    test('rejects out-of-range and non-integer values', () => {
        assertRejected(
            () => validateAnswers(
                [{ question_id: Q1, answer_value: 6 }, { question_id: Q2, answer_value: 2.5 }],
                [Q1, Q2],
                WHO5_SCALE
            ),
            'answers[0].answer_value: must be a whole number between 0 and 5',
            'answers[1].answer_value'
        )
    })

    test('rejects missing, duplicate and foreign questions', () => {
        assertRejected(
            () => validateAnswers(
                [
                    { question_id: Q1, answer_value: 1 },
                    { question_id: Q1, answer_value: 2 },
                    { question_id: 'a0000000-0000-0000-0000-000000000099', answer_value: 3 }
                ],
                [Q1, Q2],
                WHO5_SCALE
            ),
            'answers[1].question_id: is answered more than once',
            'answers[2].question_id: is not a question of this questionnaire',
            'answers: 1 of 2 questions are not answered'
        )
    })
})

describe('parseLanguages', () => {
    test('returns every language when none is requested', () => {
        assert.deepEqual(parseLanguages(undefined), [])
    })

    test('accepts known codes and drops duplicates', () => {
        assert.deepEqual(parseLanguages('en, zh,en'), ['en', 'zh'])
    })

    test('rejects anything else, so nothing unexpected reaches the SQL', () => {
        assertRejected(() => parseLanguages("en,x' OR 1=1--"), 'Invalid language code')
    })
})
