import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import questionnaireController from './questionnaire.controller.js'
import questionnaireModel from '../models/questionnaire.model.js'
import sessionModel from '../models/session.model.js'
import { BadRequestError, ConflictError, NotFoundError } from '../utils/AppError.js'

const SESSION_ID = 'f0000000-0000-0000-0000-000000000001'
const WHO5_ID = '31ed48e7-614d-489b-930f-0143ff11c8e2'
const BFI2_ID = '3329bb5c-e73f-4dfc-8cb3-c6f44cd7e435'
const QUESTION_IDS = [1, 2, 3, 4, 5].map(n => `a0000000-0000-0000-0000-00000000000${n}`)

const invoke = async (handler, req) => {
    const response = {
        statusCode: 200,
        status: mock.fn(function (code) { this.statusCode = code; return this }),
        json: mock.fn(value => value)
    }
    const next = mock.fn()
    handler(req, response, next)
    await new Promise(resolve => setImmediate(resolve))
    return { response, next }
}

const answerReq = answers => ({
    user: { role: 'technician', sub: 'b0000000-0000-0000-0000-000000000002' },
    validated: { session_id: SESSION_ID, questionnaire_id: WHO5_ID },
    body: { answers },
    query: {},
    dbClient: {}
})

const allAnswers = value => QUESTION_IDS.map(question_id => ({ question_id, answer_value: value }))

const mockWho5 = ({ syncStatus = 'completed', answered = false } = {}) => {
    mock.method(sessionModel, 'findById', async () => [{ session_id: SESSION_ID, sync_status: syncStatus }])
    mock.method(questionnaireModel, 'findById', async () => [{ questionnaire_id: WHO5_ID, code: 'who5', scale_min: 0, scale_max: 5 }])
    mock.method(questionnaireModel, 'findQuestionsByQuestionnaireId', async () => QUESTION_IDS.map(question_id => ({ question_id })))
    mock.method(questionnaireModel, 'hasAnswers', async () => answered)
}

afterEach(() => mock.restoreAll())

describe('POST /questionnaires/answer', () => {
    test('saves a complete WHO-5 submission and returns its scores', async () => {
        mockWho5()
        const insert = mock.method(questionnaireModel, 'insertAnswers', async (s, q, answers) =>
            answers.map(a => ({ session_id: s, questionnaire_id: q, question_id: a.question_id, response_value: a.answer_value })))
        mock.method(questionnaireModel, 'findSessionScores', async () => [
            { questionnaire_id: WHO5_ID, score_level: 'total', domain: null, facet: null, raw_score: 20, mean_score: 4, percentage_score: 80, answered_items: 5, expected_items: 5, is_complete: true }
        ])

        const { response, next } = await invoke(questionnaireController.answerQuestionnaire, answerReq(allAnswers(4)))

        assert.equal(next.mock.callCount(), 0)
        assert.equal(insert.mock.calls[0].arguments[2].length, 5)
        assert.equal(response.status.mock.calls[0].arguments[0], 201)
        assert.equal(response.json.mock.calls[0].arguments[0].scores.total.percentage_score, 80)
    })

    test('refuses a session that has not completed', async () => {
        mockWho5({ syncStatus: 'recording' })
        const insert = mock.method(questionnaireModel, 'insertAnswers', async () => [])

        const { next } = await invoke(questionnaireController.answerQuestionnaire, answerReq(allAnswers(3)))

        assert.ok(next.mock.calls[0].arguments[0] instanceof ConflictError)
        assert.equal(insert.mock.callCount(), 0)
    })

    test('refuses an incomplete submission', async () => {
        mockWho5()
        const insert = mock.method(questionnaireModel, 'insertAnswers', async () => [])

        const { next } = await invoke(questionnaireController.answerQuestionnaire, answerReq(allAnswers(3).slice(0, 4)))

        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
        assert.equal(insert.mock.callCount(), 0)
    })

    test('refuses a questionnaire already submitted for the session', async () => {
        mockWho5({ answered: true })
        const insert = mock.method(questionnaireModel, 'insertAnswers', async () => [])

        const { next } = await invoke(questionnaireController.answerQuestionnaire, answerReq(allAnswers(3)))

        assert.ok(next.mock.calls[0].arguments[0] instanceof ConflictError)
        assert.equal(insert.mock.callCount(), 0)
    })

    test('returns 404 for a session that is not visible', async () => {
        mock.method(sessionModel, 'findById', async () => [])

        const { next } = await invoke(questionnaireController.answerQuestionnaire, answerReq(allAnswers(3)))

        assert.ok(next.mock.calls[0].arguments[0] instanceof NotFoundError)
    })
})

describe('GET /sessions/:session_id/questionnaires', () => {
    test('groups answers and scores per questionnaire, including unanswered ones', async () => {
        mock.method(sessionModel, 'findById', async () => [{ session_id: SESSION_ID }])
        mock.method(questionnaireModel, 'listWithItemCounts', async () => [
            { questionnaire_id: BFI2_ID, code: 'bfi2', name: 'BFI-2', scale_min: 1, scale_max: 5, expected_items: 60 },
            { questionnaire_id: WHO5_ID, code: 'who5', name: 'WHO-5', scale_min: 0, scale_max: 5, expected_items: 5 }
        ])
        mock.method(questionnaireModel, 'findSessionAnswers', async () => QUESTION_IDS.map((question_id, i) => ({
            questionnaire_id: WHO5_ID, question_id, question_no: i + 1, answer_value: 3, item_score: 3,
            created_at: new Date(`2026-10-15T08:0${i}:00Z`)
        })))
        mock.method(questionnaireModel, 'findSessionScores', async () => [
            { questionnaire_id: WHO5_ID, score_level: 'total', domain: null, facet: null, raw_score: 15, mean_score: 3, percentage_score: 60, answered_items: 5, expected_items: 5, is_complete: true }
        ])

        const { response, next } = await invoke(questionnaireController.getSessionQuestionnaires, {
            validated: { session_id: SESSION_ID }, dbClient: {}
        })

        assert.equal(next.mock.callCount(), 0)
        const [bfi2, who5] = response.json.mock.calls[0].arguments[0]
        assert.equal(bfi2.answered_items, 0)
        assert.equal(bfi2.is_complete, false)
        assert.equal(bfi2.scores, null)
        assert.equal(who5.is_complete, true)
        assert.equal(who5.scores.total.raw_score, 15)
        assert.equal(who5.answers.length, 5)
        assert.equal(who5.submitted_at.toISOString(), '2026-10-15T08:04:00.000Z')
    })

    test('names BFI-2 domains and orders them E, A, C, N, O', async () => {
        mock.method(sessionModel, 'findById', async () => [{ session_id: SESSION_ID }])
        mock.method(questionnaireModel, 'listWithItemCounts', async () => [
            { questionnaire_id: BFI2_ID, code: 'bfi2', name: 'BFI-2', scale_min: 1, scale_max: 5, expected_items: 60 }
        ])
        mock.method(questionnaireModel, 'findSessionAnswers', async () => [{ questionnaire_id: BFI2_ID, question_id: QUESTION_IDS[0] }])
        mock.method(questionnaireModel, 'findSessionScores', async () => ['O', 'E', 'N'].map(domain => ({
            questionnaire_id: BFI2_ID, score_level: 'domain', domain, facet: null, mean_score: 3.5
        })))

        const { response } = await invoke(questionnaireController.getSessionQuestionnaires, {
            validated: { session_id: SESSION_ID }, dbClient: {}
        })

        const domains = response.json.mock.calls[0].arguments[0][0].scores.domains
        assert.deepEqual(domains.map(d => d.domain), ['E', 'N', 'O'])
        assert.equal(domains[0].domain_name, 'Extraversion')
    })
})
