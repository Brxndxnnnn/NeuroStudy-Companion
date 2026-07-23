import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import { body, param } from 'express-validator'
import errorHandler from './errorHandler.js'
import validateRequest from './validateRequest.js'

let baseUrl
let server

before(async () => {
    const app = express()

    app.use(express.json())

    app.post(
        '/users',
        [
            body('email')
                .isString()
                .withMessage('must be a string')
                .trim()
                .isEmail()
                .withMessage('must be a valid email')
                .normalizeEmail({ all_lowercase: false }),

            body('password')
                .isString()
                .withMessage('must be a string')
                .isLength({ min: 12, max: 128 })
                .withMessage('must be between 12 and 128 characters'),

            body('display_name')
                .isString()
                .withMessage('must be a string')
                .trim(),

            body('role_id')
                .isUUID(4)
                .withMessage('must be a valid UUID'),

            body('clinic_id')
                .optional({ nullable: true })
                .isUUID(4)
                .withMessage('must be a valid UUID')
        ],
        validateRequest,
        (req, res) => {
            res.json({
                validated: req.validated,
                raw: req.body
            })
        }
    )

    app.get(
        '/users/:id',
        [
            param('id')
                .isUUID(4)
                .withMessage('must be a valid UUID')
        ],
        validateRequest,
        (req, res) => {
            res.json({
                validated: req.validated
            })
        }
    )

    app.use(errorHandler)

    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve)
    })

    const address = server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
    await new Promise((resolve, reject) => {
        server.close(error => {
            if (error)
                reject(error)
            else
                resolve()
        })
    })
})

test("passes validated and sanitized body fields to the controller", async () => {
    const response = await fetch(`${baseUrl}/users`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            email: "  TEST@EXAMPLE.COM  ",
            password: "secure-password-123",
            display_name: "  Test User  ",
            role_id: "550e8400-e29b-41d4-a716-446655440000",
            clinic_id: "550e8400-e29b-41d4-a716-446655440000",
            unexpected: "should not pass"
        })
    })

    assert.equal(response.status, 200)

    const body = await response.json()

    assert.deepEqual(body.validated, {
        email: "TEST@example.com",
        password: "secure-password-123",
        display_name: "Test User",
        role_id: "550e8400-e29b-41d4-a716-446655440000",
        clinic_id: "550e8400-e29b-41d4-a716-446655440000"
    })

    assert.equal(
        Object.hasOwn(body.validated, "unexpected"),
        false
    )

    assert.equal(
        body.raw.unexpected,
        "should not pass"
    )
})

test('throws BadRequestError for invalid body data', async () => {
    const response = await fetch(`${baseUrl}/users`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            email: 'not-an-email',
            display_name: 123
        })
    })

    assert.equal(response.status, 400)

    const body = await response.json()

    assert.equal(body.status, 'fail')
    assert.match(
        body.error,
        /^Request validation failed\./
    )
    assert.match(
        body.error,
        /email: must be a valid email/
    )
    assert.match(
        body.error,
        /display_name: must be a string/
    )
})

test('returns only the first error for each field', async () => {
    const response = await fetch(`${baseUrl}/users`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            email: '',
            display_name: 'Valid name'
        })
    })

    assert.equal(response.status, 400)

    const body = await response.json()

    const emailErrorCount = (
        body.error.match(/email:/g) || []
    ).length

    assert.equal(emailErrorCount, 1)
})

test('extracts validated route parameters', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'

    const response = await fetch(
        `${baseUrl}/users/${id}`
    )

    assert.equal(response.status, 200)

    const body = await response.json()

    assert.deepEqual(body.validated, { id })
})

test('rejects invalid route parameters before the controller', async () => {
    const response = await fetch(
        `${baseUrl}/users/not-a-uuid`
    )

    assert.equal(response.status, 400)

    const body = await response.json()

    assert.match(
        body.error,
        /id: must be a valid UUID/
    )
})