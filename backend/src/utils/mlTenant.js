// src/utils/mlTenant.js
//
// Tenant-ownership checks for the ML proxy routes (routes/ml.routes.js).
//
// ml_service connects to the DB as a BYPASSRLS role and has no auth of its own, so
// it does NO per-clinic filtering. The backend must therefore confirm that a
// requested session or client belongs to the caller's clinic BEFORE proxying to it.
// These helpers run against req.dbClient, which dbContext has already scoped to the
// caller (app.current_clinic_id / app.is_admin), so row-level security does the
// filtering for us: a row from another clinic is simply invisible to the query.

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)

// True when the session is visible to the caller (RLS-scoped client).
export const sessionInClinic = async (client, sessionId) => {
    const { rows } = await client.query(
        'SELECT 1 FROM sessions WHERE session_id = $1::uuid',
        [sessionId]
    )
    return rows.length > 0
}

// True when the client record is visible to the caller (RLS-scoped client).
export const clientInClinic = async (client, clientId) => {
    const { rows } = await client.query(
        'SELECT 1 FROM clients WHERE client_id = $1::uuid',
        [clientId]
    )
    return rows.length > 0
}

// The subset of the given session IDs visible to the caller, as a Set for membership
// tests. Used to trim a cross-clinic list returned by ml_service down to the caller's
// own clinic. An admin's RLS context returns them all, so nothing is trimmed.
export const visibleSessionIds = async (client, sessionIds) => {
    if (!sessionIds.length) return new Set()
    const { rows } = await client.query(
        'SELECT session_id FROM sessions WHERE session_id = ANY($1::uuid[])',
        [sessionIds]
    )
    return new Set(rows.map((r) => r.session_id))
}
