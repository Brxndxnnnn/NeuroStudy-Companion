import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import sessionCommentaryController from './sessionCommentary.controller.js'
import sessionModel from '../models/session.model.js'
import sessionCommentaryModel from '../models/sessionCommentary.model.js'
import { BadRequestError, ConflictError, NotFoundError } from '../utils/AppError.js'
import { COMMENTARY_TEXT_FIELDS } from '../validators/sessionCommentary.validators.js'

const SESSION_ID = 'f0000000-0000-0000-0000-000000000001'
const COMMENTARY_ID = 'e0000000-0000-0000-0000-000000000002'
const USER_ID = 'b0000000-0000-0000-0000-000000000002'

const completeCommentary = () =>
    Object.fromEntries(COMMENTARY_TEXT_FIELDS.map(field => [field, `Text for ${field}`]))

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
    validated: { session_id: SESSION_ID },
    dbClient: {},
    ...extra
})

const sessionExists = () => mock.method(sessionModel, 'findById', async () => [{ session_id: SESSION_ID }])

afterEach(() => mock.restoreAll())

describe('session commentary controller', () => {
    test('lists commentary versions', async () => {
        sessionExists()
        const list = mock.method(sessionCommentaryModel, 'listBySessionId', async () => [
            { commentary_id: COMMENTARY_ID, version: 1, status: 'active' }
        ])

        const { response, next } = await invoke(sessionCommentaryController.listCommentaries, technicianReq())

        assert.equal(next.mock.callCount(), 0)
        assert.equal(list.mock.calls[0].arguments[0], SESSION_ID)
        assert.equal(response.json.mock.calls[0].arguments[0].length, 1)
    })

    test('returns 404 when the session is not visible', async () => {
        mock.method(sessionModel, 'findById', async () => [])
        const find = mock.method(sessionCommentaryModel, 'findByStatus', async () => null)

        const { next } = await invoke(sessionCommentaryController.getActiveCommentary, technicianReq())

        assert.ok(next.mock.calls[0].arguments[0] instanceof NotFoundError)
        assert.equal(find.mock.callCount(), 0)
    })

    test('returns the active commentary', async () => {
        sessionExists()
        const find = mock.method(sessionCommentaryModel, 'findByStatus', async () => ({ commentary_id: COMMENTARY_ID, status: 'active' }))

        const { response, next } = await invoke(sessionCommentaryController.getActiveCommentary, technicianReq())

        assert.equal(next.mock.callCount(), 0)
        assert.deepEqual(find.mock.calls[0].arguments.slice(0, 2), [SESSION_ID, 'active'])
        assert.equal(response.json.mock.calls[0].arguments[0].status, 'active')
    })

    test('returns a specific version of this session', async () => {
        sessionExists()
        mock.method(sessionCommentaryModel, 'findById', async () => ({ commentary_id: COMMENTARY_ID, session_id: SESSION_ID, status: 'superseded' }))

        const { response, next } = await invoke(sessionCommentaryController.getCommentaryById, technicianReq({
            validated: { session_id: SESSION_ID.toUpperCase(), commentary_id: COMMENTARY_ID }
        }))

        assert.equal(next.mock.callCount(), 0)
        assert.equal(response.json.mock.calls[0].arguments[0].status, 'superseded')
    })

    test('hides a commentary that belongs to another session', async () => {
        sessionExists()
        mock.method(sessionCommentaryModel, 'findById', async () => ({
            commentary_id: COMMENTARY_ID, session_id: 'f0000000-0000-0000-0000-000000000099'
        }))

        const { next } = await invoke(sessionCommentaryController.getCommentaryById, technicianReq({
            validated: { session_id: SESSION_ID, commentary_id: COMMENTARY_ID }
        }))

        assert.ok(next.mock.calls[0].arguments[0] instanceof NotFoundError)
    })

    test('saves a partial draft', async () => {
        sessionExists()
        const save = mock.method(sessionCommentaryModel, 'saveDraft', async () => COMMENTARY_ID)
        mock.method(sessionCommentaryModel, 'findById', async () => ({ commentary_id: COMMENTARY_ID, status: 'draft' }))

        const { response, next } = await invoke(sessionCommentaryController.saveDraftCommentary, technicianReq({
            body: { anamnesis: 'Poor sleep' }
        }))

        assert.equal(next.mock.callCount(), 0)
        const [sessionId, commentary, userId] = save.mock.calls[0].arguments
        assert.equal(sessionId, SESSION_ID)
        assert.equal(commentary.anamnesis, 'Poor sleep')
        assert.equal(commentary.eeg_conclusion, null)
        assert.equal(userId, USER_ID)
        assert.equal(response.json.mock.calls[0].arguments[0].status, 'draft')
    })

    test('rejects an invalid draft before touching the database', async () => {
        const save = mock.method(sessionCommentaryModel, 'saveDraft', async () => COMMENTARY_ID)

        const { next } = await invoke(sessionCommentaryController.saveDraftCommentary, technicianReq({
            body: { anamnesis: ['not', 'text'] }
        }))

        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
        assert.equal(save.mock.callCount(), 0)
    })

    test('refuses to publish an incomplete draft', async () => {
        sessionExists()
        mock.method(sessionCommentaryModel, 'findByStatus', async () => ({
            ...completeCommentary(), commentary_id: COMMENTARY_ID, status: 'draft', eeg_eyes_open: null
        }))
        const publish = mock.method(sessionCommentaryModel, 'publish', async () => COMMENTARY_ID)

        const { next } = await invoke(sessionCommentaryController.publishDraftCommentary, technicianReq())

        const err = next.mock.calls[0].arguments[0]
        assert.ok(err instanceof BadRequestError)
        assert.ok(err.message.includes('eeg_eyes_open: is required'))
        assert.equal(publish.mock.callCount(), 0)
    })

    test('publishes a complete draft', async () => {
        sessionExists()
        mock.method(sessionCommentaryModel, 'findByStatus', async () => ({ ...completeCommentary(), commentary_id: COMMENTARY_ID, status: 'draft' }))
        const publish = mock.method(sessionCommentaryModel, 'publish', async () => COMMENTARY_ID)
        mock.method(sessionCommentaryModel, 'findById', async () => ({ commentary_id: COMMENTARY_ID, status: 'active', version: 1 }))

        const { response, next } = await invoke(sessionCommentaryController.publishDraftCommentary, technicianReq())

        assert.equal(next.mock.callCount(), 0)
        assert.deepEqual(publish.mock.calls[0].arguments.slice(0, 2), [COMMENTARY_ID, USER_ID])
        assert.equal(response.json.mock.calls[0].arguments[0].version, 1)
    })

    test('reports a conflict when the draft is published concurrently', async () => {
        sessionExists()
        mock.method(sessionCommentaryModel, 'findByStatus', async () => ({ ...completeCommentary(), commentary_id: COMMENTARY_ID, status: 'draft' }))
        mock.method(sessionCommentaryModel, 'publish', async () => null)

        const { next } = await invoke(sessionCommentaryController.publishDraftCommentary, technicianReq())

        assert.ok(next.mock.calls[0].arguments[0] instanceof ConflictError)
    })

    test('discards a draft', async () => {
        sessionExists()
        mock.method(sessionCommentaryModel, 'deleteDraft', async () => COMMENTARY_ID)

        const { response, next } = await invoke(sessionCommentaryController.deleteDraftCommentary, technicianReq())

        assert.equal(next.mock.callCount(), 0)
        assert.equal(response.status.mock.calls[0].arguments[0], 204)
    })
})
