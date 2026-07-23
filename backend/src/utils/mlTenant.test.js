import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
    isUuid,
    sessionInClinic,
    clientInClinic,
    visibleSessionIds,
} from './mlTenant.js'

const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'

// A fake pg client whose query() returns a fixed result and records what it was
// called with. Mirrors the RLS-scoped req.dbClient the real middleware provides.
const fakeClient = (rows, capture = {}) => ({
    query: async (sql, params) => {
        capture.sql = sql
        capture.params = params
        return { rows }
    },
})

describe('mlTenant.isUuid', () => {
    test('accepts a well-formed UUID', () => {
        assert.equal(isUuid(UUID_A), true)
    })
    test('rejects non-UUID strings and non-strings', () => {
        assert.equal(isUuid('not-a-uuid'), false)
        assert.equal(isUuid('1; DROP TABLE sessions;'), false)
        assert.equal(isUuid(''), false)
        assert.equal(isUuid(undefined), false)
        assert.equal(isUuid(null), false)
        assert.equal(isUuid(12345), false)
    })
})

describe('mlTenant.sessionInClinic', () => {
    test('true when RLS returns the row (visible to caller)', async () => {
        const cap = {}
        assert.equal(await sessionInClinic(fakeClient([{ '?column?': 1 }], cap), UUID_A), true)
        assert.deepEqual(cap.params, [UUID_A])
    })
    test('false when RLS hides the row (another clinic)', async () => {
        assert.equal(await sessionInClinic(fakeClient([]), UUID_A), false)
    })
})

describe('mlTenant.clientInClinic', () => {
    test('true when the client row is visible', async () => {
        assert.equal(await clientInClinic(fakeClient([{ '?column?': 1 }]), UUID_A), true)
    })
    test('false when the client row is not visible', async () => {
        assert.equal(await clientInClinic(fakeClient([]), UUID_A), false)
    })
})

describe('mlTenant.visibleSessionIds', () => {
    test('empty input returns an empty set without querying', async () => {
        const cap = {}
        const set = await visibleSessionIds(fakeClient([{ session_id: UUID_A }], cap), [])
        assert.equal(set.size, 0)
        assert.equal(cap.sql, undefined) // never queried
    })
    test('returns only the IDs RLS made visible', async () => {
        // Caller asked about A and B; RLS only returns A → B was another clinic's.
        const set = await visibleSessionIds(fakeClient([{ session_id: UUID_A }]), [UUID_A, UUID_B])
        assert.equal(set.has(UUID_A), true)
        assert.equal(set.has(UUID_B), false)
    })
})
