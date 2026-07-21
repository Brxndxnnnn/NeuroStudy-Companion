import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import authenticate from './authenticate.js'
import authService from '../services/auth.service.js'
import { UnauthorizedError } from '../utils/AppError.js'

// AppError subclasses never set `this.name`, so err.name is always the
// generic "Error" (a JS class-inheritance gotcha, not a bug — nothing in
// the app relies on .name). Match on the real class + status instead.
const isUnauthorized = (err) => err instanceof UnauthorizedError && err.statusCode === 401

function fakeReq(header) {
  return { headers: { authorization: header } }
}

describe('authenticate middleware', () => {
  test('rejects a missing Authorization header', async () => {
    const next = mock.fn()
    await assert.rejects(
      () => authenticate(fakeReq(undefined), {}, next),
      isUnauthorized
    )
    assert.equal(next.mock.callCount(), 0)
  })

  test('rejects a header without the Bearer prefix', async () => {
    const next = mock.fn()
    await assert.rejects(
      () => authenticate(fakeReq('Basic abc123'), {}, next),
      isUnauthorized
    )
  })

  test('rejects a syntactically fine but invalid/expired token', async () => {
    mock.method(authService, 'verifyAccessToken', () => {
      throw new Error('jwt expired')
    })
    const next = mock.fn()
    await assert.rejects(
      () => authenticate(fakeReq('Bearer bad.token.here'), {}, next),
      isUnauthorized
    )
    mock.restoreAll()
  })

  test('rejects a token whose payload is missing required claims', async () => {
    mock.method(authService, 'verifyAccessToken', () => ({ sub: 'user-1' })) // no jti
    const next = mock.fn()
    await assert.rejects(
      () => authenticate(fakeReq('Bearer token'), {}, next),
      isUnauthorized
    )
    mock.restoreAll()
  })

  test('rejects a revoked token even with a valid signature', async () => {
    mock.method(authService, 'verifyAccessToken', () => ({ jti: 'jti-1', sub: 'user-1', role: 'technician' }))
    mock.method(authService, 'isRevoked', async () => true)
    const next = mock.fn()
    await assert.rejects(
      () => authenticate(fakeReq('Bearer token'), {}, next),
      isUnauthorized
    )
    mock.restoreAll()
  })

  test('accepts a valid, non-revoked token and attaches req.user', async () => {
    const payload = { jti: 'jti-2', sub: 'user-2', email: 'a@b.com', role: 'technician', role_id: 3 }
    mock.method(authService, 'verifyAccessToken', () => payload)
    mock.method(authService, 'isRevoked', async () => false)
    const next = mock.fn()
    const req = fakeReq('Bearer token')
    await authenticate(req, {}, next)
    assert.equal(next.mock.callCount(), 1)
    assert.deepEqual(req.user, payload)
    mock.restoreAll()
  })
})
