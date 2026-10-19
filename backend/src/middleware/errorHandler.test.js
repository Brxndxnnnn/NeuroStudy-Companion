import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import errorHandler from './errorHandler.js'

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
  return res
}

describe('errorHandler', () => {
  test('operational error (isOperational) sends its own status and message', () => {
    const err = { isOperational: true, statusCode: 404, message: 'Client not found' }
    const res = fakeRes()
    errorHandler(err, {}, res, () => {})
    assert.equal(res.statusCode, 404)
    assert.equal(res.body.error, 'Client not found')
    assert.equal(res.body.status, 'fail')
  })

  test('unknown 500 error hides its real message from the client', () => {
    const err = new Error('leaked internal detail: password column missing')
    const res = fakeRes()
    errorHandler(err, {}, res, () => {})
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.message, 'Something went very wrong on our end. Please try again later.')
    assert.ok(!JSON.stringify(res.body).includes('leaked internal detail'))
  })

  test('client history and pairing SQLSTATEs map to their HTTP statuses', () => {
    const expected = { P2006: 409, P2101: 404, P2102: 409, P2103: 409, P2201: 404, P2202: 409, P2203: 400, P2301: 404, P2302: 400 }
    for (const [code, status] of Object.entries(expected)) {
      const res = fakeRes()
      errorHandler({ code, message: `raised ${code}` }, {}, res, () => {})
      assert.equal(res.statusCode, status, code)
      assert.equal(res.body.error, `raised ${code}`)
    }
  })

  test('foreign_key_violation (23503) on clinic_id maps to a readable 400', () => {
    const err = { code: '23503', constraint: 'sessions_clinic_id_fkey', message: 'fk violation' }
    const res = fakeRes()
    errorHandler(err, {}, res, () => {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'Invalid clinic_id: The specified clinic does not exist.')
  })

  test('foreign_key_violation (23503) on an unrecognised constraint falls back to a generic message', () => {
    const err = { code: '23503', constraint: 'something_unexpected_fkey', message: 'fk violation' }
    const res = fakeRes()
    errorHandler(err, {}, res, () => {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'Foreign key violation: A related resource does not exist')
  })

  test('unique_violation (23505) maps to a 409 including the detail', () => {
    const err = { code: '23505', detail: 'Key (email)=(a@b.com) already exists.', message: 'dup' }
    const res = fakeRes()
    errorHandler(err, {}, res, () => {})
    assert.equal(res.statusCode, 409)
    assert.match(res.body.error, /already exists/)
  })

  test('not_null_violation (23502) names the missing column', () => {
    const err = { code: '23502', column: 'display_name', message: 'not null' }
    const res = fakeRes()
    errorHandler(err, {}, res, () => {})
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'Missing required field: display_name')
  })

  test('unrecognised Postgres error code falls through to the generic 500 handler', () => {
    const err = { code: '99999', message: 'some new error code we do not map' }
    const res = fakeRes()
    errorHandler(err, {}, res, () => {})
    assert.equal(res.statusCode, 500)
  })
})
