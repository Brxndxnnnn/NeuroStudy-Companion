import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import mlGroupController from './mlGroup.controller.js'
import mlGroupModel from '../models/mlGroup.model.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

const G1 = 'a0000000-0000-0000-0000-000000000001'
const G2 = 'a0000000-0000-0000-0000-000000000002'
const C1 = 'c0000000-0000-0000-0000-000000000001'
const CLINIC = 'e0000000-0000-0000-0000-000000000001'

const invoke = async (handler, req) => {
    const response = {
        statusCode: 200,
        status: mock.fn(function (code) { this.statusCode = code; return this }),
        json: mock.fn(value => value),
        end: mock.fn()
    }
    const next = mock.fn()
    handler({ dbClient: {}, params: {}, body: {}, user: { sub: 'u1', clinic_id: CLINIC }, ...req }, response, next)
    await new Promise(resolve => setTimeout(resolve, 5))
    return { response, next }
}

const fetchReturning = (status, body) => mock.method(globalThis, 'fetch', async () => ({
    status, json: async () => body
}))

afterEach(() => mock.restoreAll())

describe('GET /api/ml/groups', () => {
    test('attaches each visible group its current model, and never another clinic\'s', async () => {
        mock.method(mlGroupModel, 'listWithMembers', async () => [{ group_id: G1, name: 'A', members: [] }])
        fetchReturning(200, { models: [{ group_id: G1, model_version: 3 }, { group_id: G2, model_version: 9 }] })

        const { response, next } = await invoke(mlGroupController.listGroups, {})

        assert.equal(next.mock.callCount(), 0)
        const body = response.json.mock.calls[0].arguments[0]
        assert.equal(body.groups.length, 1)
        assert.equal(body.groups[0].current_model.model_version, 3)
        assert.equal(body.models_available, true)
    })

    test('still lists groups when the ML service is down', async () => {
        mock.method(mlGroupModel, 'listWithMembers', async () => [{ group_id: G1, name: 'A', members: [] }])
        mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED') })

        const { response } = await invoke(mlGroupController.listGroups, {})
        const body = response.json.mock.calls[0].arguments[0]
        assert.equal(body.groups[0].current_model, null)
        assert.equal(body.models_available, false)
    })
})

describe('POST /api/ml/groups', () => {
    test('creates the group in the technician\'s clinic', async () => {
        const create = mock.method(mlGroupModel, 'create', async () => G1)
        const { response, next } = await invoke(mlGroupController.createGroup, { body: { name: ' Kids ', client_ids: [C1] } })

        assert.equal(next.mock.callCount(), 0)
        assert.equal(response.status.mock.calls[0].arguments[0], 201)
        assert.deepEqual(create.mock.calls[0].arguments[0], { name: 'Kids', clinic_id: CLINIC, created_by: 'u1', client_ids: [C1] })
    })

    test('an admin\'s group takes its members\' clinic, which must be one', async () => {
        mock.method(mlGroupModel, 'clinicsOfClients', async () => ['x', 'y'])
        const { next } = await invoke(mlGroupController.createGroup, {
            body: { name: 'Mixed', client_ids: [C1] }, user: { sub: 'admin', clinic_id: null }
        })
        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
    })
})

describe('group edits and training', () => {
    test('404 when updating a group the caller cannot see', async () => {
        mock.method(mlGroupModel, 'update', async () => false)
        const { next } = await invoke(mlGroupController.updateGroup, { params: { groupId: G1 }, body: { name: 'B' } })
        assert.ok(next.mock.calls[0].arguments[0] instanceof NotFoundError)
    })

    test('training checks the group is visible before calling the ML service', async () => {
        mock.method(mlGroupModel, 'findById', async () => null)
        const fetch = fetchReturning(200, {})
        const { next } = await invoke(mlGroupController.trainGroup, { params: { groupId: G1 } })
        assert.ok(next.mock.calls[0].arguments[0] instanceof NotFoundError)
        assert.equal(fetch.mock.callCount(), 0)
    })

    test('training proxies to the group\'s train endpoint', async () => {
        mock.method(mlGroupModel, 'findById', async () => ({ group_id: G1 }))
        const fetch = fetchReturning(200, { trained: true, model_version: 4 })
        const { response } = await invoke(mlGroupController.trainGroup, { params: { groupId: G1 }, body: {} })
        assert.match(fetch.mock.calls[0].arguments[0], new RegExp(`/phase1/groups/${G1}/train$`))
        assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).predict, true)
        assert.equal(response.json.mock.calls[0].arguments[0].model_version, 4)
    })

    test('rejects a malformed group id', async () => {
        const { next } = await invoke(mlGroupController.deleteGroup, { params: { groupId: 'nope' } })
        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
    })
})

describe('GET /api/ml/groups/:groupId/fit', () => {
    test('proxies once the group and client are visible and in the same clinic', async () => {
        mock.method(mlGroupModel, 'findById', async () => ({ group_id: G1, clinic_id: CLINIC }))
        mock.method(mlGroupModel, 'clinicOfClient', async () => CLINIC)
        const fetch = fetchReturning(200, { client_id: C1, personality: { available: true } })
        const { response, next } = await invoke(mlGroupController.compareClient, {
            params: { groupId: G1 }, query: { client_id: C1 }
        })
        assert.equal(next.mock.callCount(), 0)
        assert.ok(fetch.mock.calls[0].arguments[0].endsWith(`/phase1/groups/${G1}/fit?client_id=${C1}`))
        assert.equal(response.json.mock.calls[0].arguments[0].client_id, C1)
    })

    test('never calls the ML service for a client from another clinic', async () => {
        mock.method(mlGroupModel, 'findById', async () => ({ group_id: G1, clinic_id: CLINIC }))
        mock.method(mlGroupModel, 'clinicOfClient', async () => 'e0000000-0000-0000-0000-000000000099')
        const fetch = fetchReturning(200, {})
        const { next } = await invoke(mlGroupController.compareClient, {
            params: { groupId: G1 }, query: { client_id: C1 }
        })
        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
        assert.equal(fetch.mock.callCount(), 0)
    })

    test('404 for a client the caller cannot see', async () => {
        mock.method(mlGroupModel, 'findById', async () => ({ group_id: G1, clinic_id: CLINIC }))
        mock.method(mlGroupModel, 'clinicOfClient', async () => null)
        const { next } = await invoke(mlGroupController.compareClient, {
            params: { groupId: G1 }, query: { client_id: C1 }
        })
        assert.ok(next.mock.calls[0].arguments[0] instanceof NotFoundError)
    })

    test('rejects a missing client_id', async () => {
        const { next } = await invoke(mlGroupController.compareClient, { params: { groupId: G1 }, query: {} })
        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
    })
})
