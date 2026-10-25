import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { validateGroupBody } from './mlGroup.validators.js'
import { BadRequestError } from '../utils/AppError.js'

const A = 'a0000000-0000-0000-0000-000000000001'
const B = 'B0000000-0000-0000-0000-000000000002'

describe('validateGroupBody', () => {
    test('trims the name and de-duplicates members (case-insensitive)', () => {
        const out = validateGroupBody({ name: '  Kids 8-12 ', client_ids: [A, B, B.toLowerCase()] })
        assert.equal(out.name, 'Kids 8-12')
        assert.deepEqual(out.client_ids, [A, B.toLowerCase()])
    })

    test('create requires both fields and lists every problem', () => {
        assert.throws(() => validateGroupBody({}), (err) =>
            err instanceof BadRequestError && /name is required/.test(err.message) && /client_ids/.test(err.message))
    })

    test('rejects non-UUID members and an over-long name', () => {
        assert.throws(() => validateGroupBody({ name: 'x', client_ids: ['nope'] }), /UUIDs/)
        assert.throws(() => validateGroupBody({ name: 'x'.repeat(81), client_ids: [A] }), /at most 80/)
    })

    test('update accepts either field but not neither', () => {
        assert.deepEqual(validateGroupBody({ name: 'New' }, { partial: true }), { name: 'New' })
        assert.deepEqual(validateGroupBody({ client_ids: [A] }, { partial: true }), { client_ids: [A] })
        assert.throws(() => validateGroupBody({}, { partial: true }), /nothing to update/)
    })
})
