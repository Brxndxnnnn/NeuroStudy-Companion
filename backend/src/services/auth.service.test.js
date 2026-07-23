import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import pool from '../config/db.js'
import authService from './auth.service.js'

afterEach(() => {
  mock.restoreAll()
})

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

  test('rotateRefreshSession atomically replaces the refresh-token hash', async () => {
    let capturedSql
    let capturedParams

    mock.method(pool, 'query', async (sql, params) => {
      capturedSql = sql
      capturedParams = params

      return {
        rows: [{ user_id: 'user-1' }]
      }
    })

    const result = await authService.rotateRefreshSession(
      'old-refresh-token',
      'new-refresh-token',
      '127.0.0.1',
      'test-agent'
    )

    assert.deepEqual(result, { user_id: 'user-1' })
    assert.match(capturedSql, /UPDATE active_sessions/)
    assert.match(capturedSql, /WHERE refresh_token_hash=\$1/)
    assert.match(capturedSql, /expires_at>NOW\(\)/)

    assert.equal(
      capturedParams[0],
      authService.hashToken('old-refresh-token')
    )

    assert.equal(
      capturedParams[1],
      authService.hashToken('new-refresh-token')
    )

    assert.equal(capturedParams[2], '127.0.0.1')
    assert.equal(capturedParams[3], 'test-agent')
    assert.ok(capturedParams[4] instanceof Date)
  })

  test('rotateRefreshSession atomically replaces the refresh-token hash', async () => {
    let capturedSql
    let capturedParams

    mock.method(pool, 'query', async (sql, params) => {
      capturedSql = sql
      capturedParams = params

      return {
        rows: [{ user_id: 'user-1' }]
      }
    })

    const result = await authService.rotateRefreshSession(
      'old-refresh-token',
      'new-refresh-token',
      '127.0.0.1',
      'test-agent'
    )

    assert.deepEqual(result, { user_id: 'user-1' })
    assert.match(capturedSql, /UPDATE active_sessions/)
    assert.match(capturedSql, /WHERE refresh_token_hash=\$1/)
    assert.match(capturedSql, /expires_at>NOW\(\)/)

    assert.equal(
      capturedParams[0],
      authService.hashToken('old-refresh-token')
    )

    assert.equal(
      capturedParams[1],
      authService.hashToken('new-refresh-token')
    )

    assert.equal(capturedParams[2], '127.0.0.1')
    assert.equal(capturedParams[3], 'test-agent')
    assert.ok(capturedParams[4] instanceof Date)
  })

  test('createRefreshSession hashes the token before storing it', async () => {
    let capturedParams

    mock.method(pool, 'query', async (sql, params) => {
      capturedParams = params
      return { rows: [] }
    })

    await authService.createRefreshSession(
      'user-1',
      'plain-refresh-token',
      '127.0.0.1',
      'test-agent'
    )

    assert.equal(capturedParams[0], 'user-1')
    assert.equal(
      capturedParams[1],
      authService.hashToken('plain-refresh-token')
    )
    assert.notEqual(capturedParams[1], 'plain-refresh-token')
  })
})
