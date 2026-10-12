import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import clientHistoryController from './clientHistory.controller.js'
import clientController from './client.controller.js'
import clientModel from '../models/client.model.js'
import clientHistoryModel from '../models/clientHistory.model.js'
import { BadRequestError, ConflictError, NotFoundError } from '../utils/AppError.js'
import { COMPLAINTS, SYMPTOMS } from '../validators/clientHistory.validators.js'

const CLIENT_ID = 'c0000000-0000-0000-0000-000000000001'
const HISTORY_ID = 'e0000000-0000-0000-0000-000000000001'
const USER_ID = 'b0000000-0000-0000-0000-000000000002'

const completeHistory = () => ({
    intake_date: '2026-10-13',
    medical_history: 'No surgeries',
    cognitive_behavioural_profile: 'Distractible',
    language_communication: 'Right-hand dominant',
    social_observations: 'Shy with strangers',
    treatment_goals: 'Improve focus',
    school_education: 'Private school',
    occupation: '-',
    hobbies: 'Cycling',
    complaints: COMPLAINTS.map(complaint => ({ complaint, severity: 'not_affected', comment: null })),
    symptoms: SYMPTOMS.map(symptom => ({ symptom, rating: 5, notes: null }))
})

const invoke = async (handler, req) => {
    const response = {
        statusCode: 200,
        status: mock.fn(function (code) { this.statusCode = code; return this }),
        json: mock.fn(value => value),
        send: mock.fn()
    }
    const next = mock.fn()
    handler(req, response, next)
    await new Promise(resolve => setImmediate(resolve))
    return { response, next }
}

const technicianReq = extra => ({
    user: { role: 'technician', sub: USER_ID, clinic_id: 'a0000000-0000-0000-0000-000000000001' },
    validated: { client_id: CLIENT_ID },
    dbClient: {},
    ...extra
})

const clientExists = () => mock.method(clientModel, 'findById', async () => [{ client_id: CLIENT_ID }])

afterEach(() => mock.restoreAll())

describe('client history controller', () => {
    test('lists history versions', async () => {
        clientExists()
        const list = mock.method(clientHistoryModel, 'listByClientId', async () => [
            { history_id: HISTORY_ID, version: 1, status: 'active' }
        ])

        const { response, next } = await invoke(clientHistoryController.listHistories, technicianReq())

        assert.equal(next.mock.callCount(), 0)
        assert.equal(list.mock.calls[0].arguments[0], CLIENT_ID)
        assert.equal(response.json.mock.calls[0].arguments[0].length, 1)
    })

    test('returns a specific version of this client', async () => {
        clientExists()
        mock.method(clientHistoryModel, 'findById', async () => ({ history_id: HISTORY_ID, client_id: CLIENT_ID, status: 'superseded' }))

        const { response, next } = await invoke(clientHistoryController.getHistoryById, technicianReq({
            validated: { client_id: CLIENT_ID.toUpperCase(), history_id: HISTORY_ID }
        }))

        assert.equal(next.mock.callCount(), 0)
        assert.equal(response.json.mock.calls[0].arguments[0].status, 'superseded')
    })

    test('hides a history that belongs to another client', async () => {
        clientExists()
        mock.method(clientHistoryModel, 'findById', async () => ({
            history_id: HISTORY_ID, client_id: 'c0000000-0000-0000-0000-000000000099'
        }))

        const { next } = await invoke(clientHistoryController.getHistoryById, technicianReq({
            validated: { client_id: CLIENT_ID, history_id: HISTORY_ID }
        }))

        assert.ok(next.mock.calls[0].arguments[0] instanceof NotFoundError)
    })

    test('returns the active history', async () => {
        clientExists()
        const find = mock.method(clientHistoryModel, 'findByStatus', async () => ({ history_id: HISTORY_ID, status: 'active' }))

        const { response, next } = await invoke(clientHistoryController.getActiveHistory, technicianReq())

        assert.equal(next.mock.callCount(), 0)
        assert.deepEqual(find.mock.calls[0].arguments.slice(0, 2), [CLIENT_ID, 'active'])
        assert.equal(response.json.mock.calls[0].arguments[0].history_id, HISTORY_ID)
    })

    test('returns 404 when the client is not visible', async () => {
        mock.method(clientModel, 'findById', async () => [])
        const find = mock.method(clientHistoryModel, 'findByStatus', async () => null)

        const { next } = await invoke(clientHistoryController.getActiveHistory, technicianReq())

        assert.ok(next.mock.calls[0].arguments[0] instanceof NotFoundError)
        assert.equal(find.mock.callCount(), 0)
    })

    test('returns 404 when there is no draft', async () => {
        clientExists()
        mock.method(clientHistoryModel, 'findByStatus', async () => null)

        const { next } = await invoke(clientHistoryController.getDraftHistory, technicianReq())

        assert.ok(next.mock.calls[0].arguments[0] instanceof NotFoundError)
    })

    test('saves a partial draft', async () => {
        clientExists()
        const save = mock.method(clientHistoryModel, 'saveDraft', async () => HISTORY_ID)
        mock.method(clientHistoryModel, 'findById', async () => ({ history_id: HISTORY_ID, status: 'draft' }))

        const { response, next } = await invoke(clientHistoryController.saveDraftHistory, technicianReq({
            body: { medical_history: 'Asthma' }
        }))

        assert.equal(next.mock.callCount(), 0)
        const [clientId, history, userId] = save.mock.calls[0].arguments
        assert.equal(clientId, CLIENT_ID)
        assert.equal(history.medical_history, 'Asthma')
        assert.equal(history.hobbies, null)
        assert.equal(userId, USER_ID)
        assert.equal(response.json.mock.calls[0].arguments[0].status, 'draft')
    })

    test('rejects an invalid draft before touching the database', async () => {
        const save = mock.method(clientHistoryModel, 'saveDraft', async () => HISTORY_ID)

        const { next } = await invoke(clientHistoryController.saveDraftHistory, technicianReq({
            body: { symptoms: [{ symptom: 'motivation', rating: 0 }] }
        }))

        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
        assert.equal(save.mock.callCount(), 0)
    })

    test('refuses to publish an incomplete draft', async () => {
        clientExists()
        const draft = { ...completeHistory(), history_id: HISTORY_ID, status: 'draft', hobbies: null }
        mock.method(clientHistoryModel, 'findByStatus', async () => draft)
        const publish = mock.method(clientHistoryModel, 'publish', async () => HISTORY_ID)

        const { next } = await invoke(clientHistoryController.publishDraftHistory, technicianReq())

        const err = next.mock.calls[0].arguments[0]
        assert.ok(err instanceof BadRequestError)
        assert.ok(err.message.includes('hobbies: is required'))
        assert.equal(publish.mock.callCount(), 0)
    })

    test('publishes a complete draft', async () => {
        clientExists()
        mock.method(clientHistoryModel, 'findByStatus', async () => ({ ...completeHistory(), history_id: HISTORY_ID, status: 'draft' }))
        const publish = mock.method(clientHistoryModel, 'publish', async () => HISTORY_ID)
        mock.method(clientHistoryModel, 'findById', async () => ({ history_id: HISTORY_ID, status: 'active', version: 2 }))

        const { response, next } = await invoke(clientHistoryController.publishDraftHistory, technicianReq())

        assert.equal(next.mock.callCount(), 0)
        assert.deepEqual(publish.mock.calls[0].arguments.slice(0, 2), [HISTORY_ID, USER_ID])
        assert.equal(response.json.mock.calls[0].arguments[0].version, 2)
    })

    test('reports a conflict when the draft is published concurrently', async () => {
        clientExists()
        mock.method(clientHistoryModel, 'findByStatus', async () => ({ ...completeHistory(), history_id: HISTORY_ID, status: 'draft' }))
        mock.method(clientHistoryModel, 'publish', async () => null)

        const { next } = await invoke(clientHistoryController.publishDraftHistory, technicianReq())

        assert.ok(next.mock.calls[0].arguments[0] instanceof ConflictError)
    })

    test('discards a draft', async () => {
        clientExists()
        mock.method(clientHistoryModel, 'deleteDraft', async () => HISTORY_ID)

        const { response, next } = await invoke(clientHistoryController.deleteDraftHistory, technicianReq())

        assert.equal(next.mock.callCount(), 0)
        assert.equal(response.status.mock.calls[0].arguments[0], 204)
    })
})

describe('client registration', () => {
    const registration = extra => ({
        user: { role: 'technician', sub: USER_ID, clinic_id: 'a0000000-0000-0000-0000-000000000001' },
        dbClient: {},
        body: { name: 'L', dob: '2016-01-01', gender: 'Male', race: 'Chinese', history: completeHistory(), ...extra }
    })

    test('creates the client with its published history', async () => {
        const create = mock.method(clientModel, 'createWithHistory', async clientData => ({
            client: { client_id: CLIENT_ID, ...clientData },
            history_id: HISTORY_ID
        }))
        mock.method(clientHistoryModel, 'findById', async () => ({ history_id: HISTORY_ID, status: 'active', version: 1 }))

        const { response, next } = await invoke(clientController.createClient, registration())

        assert.equal(next.mock.callCount(), 0)
        const [clientData, history, userId] = create.mock.calls[0].arguments
        assert.equal(clientData.clinic_id, 'a0000000-0000-0000-0000-000000000001')
        assert.equal(history.complaints.length, 6)
        assert.equal(userId, USER_ID)
        assert.equal(response.status.mock.calls[0].arguments[0], 201)
        assert.equal(response.json.mock.calls[0].arguments[0].history.version, 1)
    })

    test('requires a history', async () => {
        const create = mock.method(clientModel, 'createWithHistory', async () => ({}))

        const { next } = await invoke(clientController.createClient, registration({ history: undefined }))

        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
        assert.equal(create.mock.callCount(), 0)
    })

    test('requires a complete history', async () => {
        const create = mock.method(clientModel, 'createWithHistory', async () => ({}))
        const history = completeHistory()
        history.symptoms = []

        const { next } = await invoke(clientController.createClient, registration({ history }))

        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
        assert.equal(create.mock.callCount(), 0)
    })
})
