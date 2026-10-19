import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { COMMENTARY_TEXT_FIELDS, validateSessionCommentary } from './sessionCommentary.validators.js'
import { BadRequestError } from '../utils/AppError.js'

const completeCommentary = () =>
    Object.fromEntries(COMMENTARY_TEXT_FIELDS.map(field => [field, `Text for ${field}`]))

const assertRejected = (fn, ...fragments) => {
    assert.throws(fn, err => {
        assert.ok(err instanceof BadRequestError)
        for (const fragment of fragments)
            assert.ok(err.message.includes(fragment), `expected "${fragment}" in "${err.message}"`)
        return true
    })
}

describe('validateSessionCommentary', () => {
    test('accepts and trims a complete commentary', () => {
        const input = completeCommentary()
        input.anamnesis = '  Reported poor sleep.  '

        const commentary = validateSessionCommentary(input, { requireComplete: true })

        assert.equal(commentary.anamnesis, 'Reported poor sleep.')
        assert.deepEqual(Object.keys(commentary), [...COMMENTARY_TEXT_FIELDS])
    })

    test('lists every missing section when completeness is required', () => {
        const input = completeCommentary()
        delete input.eeg_conclusion
        input.prognostic_estimation = '   '

        assertRejected(
            () => validateSessionCommentary(input, { requireComplete: true }),
            'eeg_conclusion: is required',
            'prognostic_estimation: is required'
        )
    })

    test('allows a partial draft and stores blanks as null', () => {
        const commentary = validateSessionCommentary({ anamnesis: 'Draft', eeg_eyes_open: '' }, { requireComplete: false })
        assert.equal(commentary.anamnesis, 'Draft')
        assert.equal(commentary.eeg_eyes_open, null)
        assert.equal(commentary.eeg_conclusion, null)
    })

    test('rejects non-string sections even in a draft', () => {
        assertRejected(
            () => validateSessionCommentary({ anamnesis: 42 }, { requireComplete: false }),
            'anamnesis: must be a string'
        )
    })

    test('rejects a commentary that is not an object', () => {
        assertRejected(() => validateSessionCommentary(null, { requireComplete: false }), 'commentary: must be an object')
    })
})
