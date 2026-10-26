// src/utils/mlClient.js
//
// The one way the backend talks to ml_service (see routes/ml.routes.js for why every call
// goes through the backend). Moved here from ml.routes.js so the ML group controller can
// use it too.

// Internal service address on the compose network. ml only `expose`s 8000, so this
// is not reachable from outside the stack.
const ML_BASE = process.env.ML_SERVICE_URL || 'http://ml:8000'

// Reads are quick. Comparing a client with a group refits the group's model, which takes
// up to a minute or two, so it gets longer (kept under nginx's 300 s for that route).
// Training does not wait at all: it runs in the background on ml_service. Both are
// bounded so a pathological request cannot hold a connection open indefinitely.
export const READ_TIMEOUT_MS = Number(process.env.ML_READ_TIMEOUT_MS || 30000)
export const COMPARE_TIMEOUT_MS = Number(process.env.ML_COMPARE_TIMEOUT_MS || 280000)

/**
 * Forward a request to ml_service and return { status, payload }. Never throws on a
 * network/parse failure — it maps that to a 502 the UI can render, because this API
 * is fine and the service behind it is not.
 */
export async function mlFetch(path, { method = 'GET', body, timeoutMs = READ_TIMEOUT_MS } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let upstream
    try {
        upstream = await fetch(`${ML_BASE}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        })
    } catch (err) {
        return {
            status: 502,
            payload: {
                status: 'error',
                message:
                    err.name === 'AbortError'
                        ? 'The ML service timed out. It may still be working — check back shortly.'
                        : 'The ML service is unreachable. It may still be starting up.',
            },
        }
    } finally {
        clearTimeout(timer)
    }

    try {
        return { status: upstream.status, payload: await upstream.json() }
    } catch {
        return {
            status: 502,
            payload: { status: 'error', message: 'The ML service returned an unreadable response.' },
        }
    }
}

export const send = (res, result) => res.status(result.status).json(result.payload)
