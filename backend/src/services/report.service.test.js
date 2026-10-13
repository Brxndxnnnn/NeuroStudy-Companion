import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import reportService from './report.service.js'
import sessionModel from '../models/session.model.js'
import clientHistoryModel from '../models/clientHistory.model.js'
import sessionCommentaryModel from '../models/sessionCommentary.model.js'
import { ConflictError, NotFoundError } from '../utils/AppError.js'

const SESSION_ID = 'f0000000-0000-0000-0000-000000000001'

afterEach(() => mock.restoreAll())

describe('report.service commentary requirement', () => {
    test('refuses a session without a published commentary before loading EEG data', async () => {
        mock.method(sessionModel, 'findById', async () => [{ session_id: SESSION_ID, has_active_commentary: false }])
        const phaseEvents = mock.method(sessionModel, 'getSessionPhaseEvents', async () => [])

        await assert.rejects(
            reportService.buildSessionReportData(SESSION_ID, {}),
            err => err instanceof ConflictError && err.message.includes('commentary')
        )
        assert.equal(phaseEvents.mock.callCount(), 0)
    })

    test('still reports a missing session as not found', async () => {
        mock.method(sessionModel, 'findById', async () => [])

        await assert.rejects(reportService.buildSessionReportData(SESSION_ID, {}), NotFoundError)
    })
})

describe('report.service history and commentary', () => {
    const session = {
        session_id: SESSION_ID, client_id: 'c1', client_history_id: 'h1', client_name: 'Test Client',
        client_dob: '2015-05-02', clinic_name: 'Clinic A', technician_name: 'Tech Alice', has_active_commentary: true,
    }
    const mockSession = (overrides = {}) => {
        mock.method(sessionModel, 'findById', async () => [{ ...session, ...overrides }])
        mock.method(sessionModel, 'getSessionPhaseEvents', async () => [])
        mock.method(sessionModel, 'getSessionFftBandPowerResults', async () => ({ samples: [] }))
        mock.method(sessionCommentaryModel, 'findByStatus', async () => ({ anamnesis: 'A' }))
    }

    test("loads the history the session was paired with, plus the active commentary", async () => {
        mockSession()
        const byId = mock.method(clientHistoryModel, 'findById', async () => ({ history_id: 'h1', is_backfilled_default: false }))

        const data = await reportService.buildSessionReportData(SESSION_ID, {})

        assert.equal(byId.mock.calls[0].arguments[0], 'h1')
        assert.equal(data.history.history_id, 'h1')
        assert.equal(data.commentary.anamnesis, 'A')
        assert.equal(data.session.clinicName, 'Clinic A')
        assert.equal(data.patient.dob, '2015-05-02')
    })

    test("falls back to the client's active history for sessions paired before histories existed", async () => {
        mockSession({ client_history_id: null })
        const active = mock.method(clientHistoryModel, 'findByStatus', async () => ({ history_id: 'h2', is_backfilled_default: false }))

        const data = await reportService.buildSessionReportData(SESSION_ID, {})

        assert.deepEqual(active.mock.calls[0].arguments.slice(0, 2), ['c1', 'active'])
        assert.equal(data.history.history_id, 'h2')
    })

    test('treats a backfilled placeholder history as absent', async () => {
        mockSession()
        mock.method(clientHistoryModel, 'findById', async () => ({ history_id: 'h1', is_backfilled_default: true }))

        const data = await reportService.buildSessionReportData(SESSION_ID, {})

        assert.equal(data.history, null)
    })
})
