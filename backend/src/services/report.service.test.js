import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import reportService from './report.service.js'
import sessionModel from '../models/session.model.js'
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
