import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import requirePermission from './requirePermission.js'
import pool from '../config/db.js'
import { UnauthorizedError, PermissionDeniedError } from '../utils/AppError.js'

describe('requirePermission middleware', () => {
  test('rejects when there is no authenticated user', async () => {
    const middleware = requirePermission('clients:read')
    await assert.rejects(
      () => middleware({}, {}, () => {}),
      (err) => err instanceof UnauthorizedError
    )
  })

  test('admins bypass the permission check entirely (no DB query)', async () => {
    const querySpy = mock.method(pool, 'query', async () => { throw new Error('should not be called') })
    const middleware = requirePermission('clients:delete')
    const next = mock.fn()
    await middleware({ user: { role: 'admin' } }, {}, next)
    assert.equal(next.mock.callCount(), 1)
    assert.equal(querySpy.mock.callCount(), 0)
    mock.restoreAll()
  })

  test('superadmins bypass the permission check entirely (no DB query)', async () => {
    const querySpy = mock.method(pool, 'query', async () => { throw new Error('should not be called') })
    const middleware = requirePermission('clients:delete')
    const next = mock.fn()
    await middleware({ user: { role: 'superadmin' } }, {}, next)
    assert.equal(next.mock.callCount(), 1)
    assert.equal(querySpy.mock.callCount(), 0)
    mock.restoreAll()
  })

  test('a non-admin with the required permission passes through', async () => {
    mock.method(pool, 'query', async (sql, params) => {
      assert.equal(params[0], 7) // role_id
      assert.equal(params[1], 'clients:read')
      return { rows: [{ '?column?': 1 }] }
    })
    const middleware = requirePermission('clients:read')
    const next = mock.fn()
    await middleware({ user: { role: 'technician', role_id: 7 } }, {}, next)
    assert.equal(next.mock.callCount(), 1)
    mock.restoreAll()
  })

  test('a non-admin without the required permission is denied', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }))
    const middleware = requirePermission('clients:delete')
    await assert.rejects(
      () => middleware({ user: { role: 'technician', role_id: 7 } }, {}, () => {}),
      (err) => err instanceof PermissionDeniedError
    )
    mock.restoreAll()
  })
})
