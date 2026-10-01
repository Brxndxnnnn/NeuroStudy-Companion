import { afterEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import siteSettingsController from './siteSettings.controller.js'
import siteSettingsModel from '../models/siteSettings.model.js'
import { BadRequestError } from '../utils/AppError.js'

const invoke = async (handler, req) => {
    const response = { json: mock.fn(value => value) }
    const next = mock.fn()
    handler(req, response, next)
    await new Promise(resolve => setImmediate(resolve))
    return { response, next }
}

afterEach(() => mock.restoreAll())

describe('site settings controller', () => {
    test('returns the global interval to an administrator', async () => {
        mock.method(siteSettingsModel, 'getImageDisplayInterval', async () => ({
            image_display_interval_seconds: 10,
            updated_at: '2026-09-25T00:00:00.000Z'
        }))

        const { response, next } = await invoke(siteSettingsController.getImageDisplayInterval, {
            user: { role: 'admin' }, dbClient: {}
        })

        assert.equal(next.mock.callCount(), 0)
        assert.deepEqual(response.json.mock.calls[0].arguments[0], {
            image_display_interval_seconds: 10,
            updated_at: '2026-09-25T00:00:00.000Z'
        })
    })

    test('validates an interval before updating it', async () => {
        const { next } = await invoke(siteSettingsController.updateImageDisplayInterval, {
            user: { role: 'admin' }, body: { image_display_interval_seconds: 61 }, dbClient: {}
        })
        assert.equal(next.mock.callCount(), 1)
        assert.ok(next.mock.calls[0].arguments[0] instanceof BadRequestError)
    })

    test('updates a valid global interval', async () => {
        const update = mock.method(siteSettingsModel, 'updateImageDisplayInterval', async seconds => ({
            image_display_interval_seconds: seconds,
            updated_at: '2026-09-25T00:00:00.000Z'
        }))

        const { response, next } = await invoke(siteSettingsController.updateImageDisplayInterval, {
            user: { role: 'admin', sub: 'b0000000-0000-0000-0000-000000000001' }, body: { image_display_interval_seconds: 25 }, dbClient: {}
        })

        assert.equal(next.mock.callCount(), 0)
        assert.equal(update.mock.calls[0].arguments[0], 25)
        assert.equal(update.mock.calls[0].arguments[1], 'b0000000-0000-0000-0000-000000000001')
        assert.equal(response.json.mock.calls[0].arguments[0].image_display_interval_seconds, 25)
    })
})
