import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import authService from './auth.service.js'

describe('auth.service crypto primitives', () => {
  test('hashToken is deterministic (same input -> same hash)', () => {
    const a = authService.hashToken('refresh-token-value')
    const b = authService.hashToken('refresh-token-value')
    assert.equal(a, b)
  })

  test('hashToken differs for different inputs', () => {
    const a = authService.hashToken('token-a')
    const b = authService.hashToken('token-b')
    assert.notEqual(a, b)
  })

  test('a hashed password verifies against its own plaintext but not another', async () => {
    const hash = await authService.hashPassword('correct horse battery staple')
    assert.equal(await authService.comparePassword('correct horse battery staple', hash), true)
    assert.equal(await authService.comparePassword('wrong password', hash), false)
  })

  test('signAccessToken produces a token verifyAccessToken accepts, carrying the same payload', () => {
    const token = authService.signAccessToken({ jti: 'jti-1', sub: 'user-1', role: 'technician' })
    const payload = authService.verifyAccessToken(token)
    assert.equal(payload.jti, 'jti-1')
    assert.equal(payload.sub, 'user-1')
    assert.equal(payload.role, 'technician')
  })

  test('verifyAccessToken rejects a token signed with a different secret', () => {
    // Simulates a forged/tampered token — must not be accepted.
    const forged = jwt.sign({ jti: 'x', sub: 'y' }, 'not-the-real-secret')
    assert.throws(() => authService.verifyAccessToken(forged))
  })
})
