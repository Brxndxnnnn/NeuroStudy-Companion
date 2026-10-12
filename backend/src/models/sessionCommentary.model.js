import pool from '../config/db.js'
import query from '../utils/query.js'
import { COMMENTARY_TEXT_FIELDS } from '../validators/sessionCommentary.validators.js'

const selectCommentary = `
    SELECT
        sc.commentary_id,
        sc.session_id,
        sc.clinic_id,
        sc.version,
        sc.status,
        ${COMMENTARY_TEXT_FIELDS.map(field => `sc.${field}`).join(',\n        ')},
        sc.created_by,
        sc.created_at,
        sc.updated_at,
        sc.published_by,
        sc.published_at
    FROM public.session_commentaries sc
`

// status is 'active' (the published commentary the report requires) or 'draft'; the
// partial unique indexes guarantee at most one of each per session.
const findByStatus = async (session_id, status, client = pool) => {
    const { rows } = await query(client,
        `${selectCommentary}
         WHERE sc.session_id = $1 AND sc.status = $2`,
        [session_id, status]
    )
    return rows[0] ?? null
}

const findById = async (commentary_id, client = pool) => {
    const { rows } = await query(client,
        `${selectCommentary}
         WHERE sc.commentary_id = $1`,
        [commentary_id]
    )
    return rows[0] ?? null
}

// Version list without the section text, newest first; a draft (no version yet) comes first.
const listBySessionId = async (session_id, client = pool) => {
    const { rows } = await query(client,
        `SELECT
            sc.commentary_id,
            sc.version,
            sc.status,
            sc.created_by,
            sc.created_at,
            sc.updated_at,
            sc.published_by,
            sc.published_at
         FROM public.session_commentaries sc
         WHERE sc.session_id = $1
         ORDER BY sc.version DESC NULLS FIRST`,
        [session_id]
    )
    return rows
}

// clinic_id is omitted on purpose: the lifecycle trigger copies it from the session,
// and also refuses sessions that have not completed (P2102).
const insertDraft = async (session_id, commentary, created_by, client) => {
    const { rows } = await query(client,
        `INSERT INTO public.session_commentaries (
            session_id, status, created_by, ${COMMENTARY_TEXT_FIELDS.join(', ')}
         )
         VALUES ($1, 'draft', $2, ${COMMENTARY_TEXT_FIELDS.map((_, i) => `$${i + 3}`).join(', ')})
         RETURNING commentary_id`,
        [session_id, created_by, ...COMMENTARY_TEXT_FIELDS.map(field => commentary[field])]
    )
    return rows[0].commentary_id
}

const updateDraft = async (commentary_id, commentary, client) => {
    await query(client,
        `UPDATE public.session_commentaries
         SET ${COMMENTARY_TEXT_FIELDS.map((field, i) => `${field} = $${i + 2}`).join(',\n             ')}
         WHERE commentary_id = $1 AND status = 'draft'`,
        [commentary_id, ...COMMENTARY_TEXT_FIELDS.map(field => commentary[field])]
    )
}

// client must be a dedicated connection (req.dbClient), not the pool: BEGIN and
// COMMIT have to run on the same connection.
const saveDraft = async (session_id, commentary, user_id, client) => {
    await query(client, 'BEGIN')
    try {
        const { rows } = await query(client,
            `SELECT commentary_id
             FROM public.session_commentaries
             WHERE session_id = $1 AND status = 'draft'
             FOR UPDATE`,
            [session_id]
        )

        let commentary_id = rows[0]?.commentary_id
        if (commentary_id)
            await updateDraft(commentary_id, commentary, client)
        else
            commentary_id = await insertDraft(session_id, commentary, user_id, client)

        await query(client, 'COMMIT')
        return commentary_id
    } catch (err) {
        await query(client, 'ROLLBACK')
        throw err
    }
}

// The lifecycle trigger assigns the version, supersedes the previous active commentary
// and re-checks completeness. Returns null if the row is no longer a draft.
const publish = async (commentary_id, published_by, client = pool) => {
    const { rows } = await query(client,
        `UPDATE public.session_commentaries
         SET status = 'active', published_by = $2
         WHERE commentary_id = $1 AND status = 'draft'
         RETURNING commentary_id`,
        [commentary_id, published_by]
    )
    return rows[0]?.commentary_id ?? null
}

const deleteDraft = async (session_id, client = pool) => {
    const { rows } = await query(client,
        `DELETE FROM public.session_commentaries
         WHERE session_id = $1 AND status = 'draft'
         RETURNING commentary_id`,
        [session_id]
    )
    return rows[0]?.commentary_id ?? null
}

export default {
    findByStatus,
    findById,
    listBySessionId,
    saveDraft,
    publish,
    deleteDraft
}
