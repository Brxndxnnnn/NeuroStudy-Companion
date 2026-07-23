import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import {
    loginLimiter,
    refreshLimiter
} from './rateLimiters.js'

let baseUrl
let server

before(async () => {
    const app = express()

    app.set('trust proxy', 1)
    app.use(express.json())

    app.post('/login', loginLimiter, (req, res) => {
        res.status(req.body.success ? 200 : 401).json({
            success: Boolean(req.body.success)
        })
    })

    app.post('/refresh', refreshLimiter, (req, res) => {
        res.json({ ok: true })
    })

    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve)
    })

    baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
    await new Promise(resolve => server.close(resolve))
})

test('login limiter blocks the eleventh failed attempt', async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
        const response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '198.51.100.10'
            },
            body: JSON.stringify({ success: false })
        })

        assert.equal(response.status, 401)
    }

    const blocked = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': '198.51.100.10'
        },
        body: JSON.stringify({ success: false })
    })

    assert.equal(blocked.status, 429)

    const body = await blocked.json()
    assert.equal(body.status, 'fail')
    assert.match(body.error, /Too many requests/)
})

test('successful logins do not consume the failed-login limit', async () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
        const response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '198.51.100.11'
            },
            body: JSON.stringify({ success: true })
        })

        assert.equal(response.status, 200)
    }
})