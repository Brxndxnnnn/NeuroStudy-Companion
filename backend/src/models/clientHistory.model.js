import pool from '../config/db.js'
import query from '../utils/query.js'
import { COMPLAINTS, HISTORY_TEXT_FIELDS, SYMPTOMS } from '../validators/clientHistory.validators.js'

// Must match v_marker in db/migrations/022_client_histories.sql: existing clients were
// given a placeholder history carrying this text so pairing kept working.
export const BACKFILLED_DEFAULT_MARKER =
    'Not recorded: default client history backfilled when client histories were introduced'

// intake_date is returned as text: pg would otherwise parse DATE into a local-time
// JavaScript Date, shifting the day depending on the server's timezone.
const selectHistory = `
    SELECT
        ch.history_id,
        ch.client_id,
        ch.clinic_id,
        ch.version,
        ch.status,
        ch.intake_date::text AS intake_date,
        ${HISTORY_TEXT_FIELDS.map(field => `ch.${field}`).join(',\n        ')},
        ch.created_by,
        ch.created_at,
        ch.updated_at,
        ch.published_by,
        ch.published_at,
        COALESCE(ch.medical_history = $2, false) AS is_backfilled_default,
        COALESCE((
            SELECT json_agg(json_build_object(
                'complaint', chc.complaint,
                'severity', chc.severity,
                'comment', chc.comment
            ))
            FROM public.client_history_complaints chc
            WHERE chc.history_id = ch.history_id
        ), '[]'::json) AS complaints,
        COALESCE((
            SELECT json_agg(json_build_object(
                'symptom', chs.symptom,
                'rating', chs.rating,
                'notes', chs.notes
            ))
            FROM public.client_history_symptoms chs
            WHERE chs.history_id = ch.history_id
        ), '[]'::json) AS symptoms
    FROM public.client_histories ch
`

const inQuestionnaireOrder = row => {
    if (!row)
        return null
    row.complaints.sort((a, b) => COMPLAINTS.indexOf(a.complaint) - COMPLAINTS.indexOf(b.complaint))
    row.symptoms.sort((a, b) => SYMPTOMS.indexOf(a.symptom) - SYMPTOMS.indexOf(b.symptom))
    return row
}

// status is 'active' (the published history used for pairing) or 'draft'; the
// partial unique indexes guarantee at most one of each per client.
const findByStatus = async (client_id, status, client = pool) => {
    const { rows } = await query(client,
        `${selectHistory}
         WHERE ch.client_id = $1 AND ch.status = $3`,
        [client_id, BACKFILLED_DEFAULT_MARKER, status]
    )
    return inQuestionnaireOrder(rows[0] ?? null)
}

const findById = async (history_id, client = pool) => {
    const { rows } = await query(client,
        `${selectHistory}
         WHERE ch.history_id = $1`,
        [history_id, BACKFILLED_DEFAULT_MARKER]
    )
    return inQuestionnaireOrder(rows[0] ?? null)
}

// clinic_id is omitted on purpose: the database triggers copy it from the client
// (or parent history) so a caller can never attach rows to another clinic.
const insertDraft = async (client_id, history, created_by, client) => {
    const { rows } = await query(client,
        `INSERT INTO public.client_histories (
            client_id, status, created_by, intake_date, ${HISTORY_TEXT_FIELDS.join(', ')}
         )
         VALUES ($1, 'draft', $2, $3, ${HISTORY_TEXT_FIELDS.map((_, i) => `$${i + 4}`).join(', ')})
         RETURNING history_id`,
        [client_id, created_by, history.intake_date, ...HISTORY_TEXT_FIELDS.map(field => history[field])]
    )
    return rows[0].history_id
}

const updateDraft = async (history_id, history, client) => {
    await query(client,
        `UPDATE public.client_histories
         SET intake_date = $2,
             ${HISTORY_TEXT_FIELDS.map((field, i) => `${field} = $${i + 3}`).join(',\n             ')}
         WHERE history_id = $1 AND status = 'draft'`,
        [history_id, history.intake_date, ...HISTORY_TEXT_FIELDS.map(field => history[field])]
    )
}

// Drafts are saved whole, so their answers are replaced rather than merged.
const replaceAnswers = async (history_id, { complaints, symptoms }, client) => {
    await query(client, 'DELETE FROM public.client_history_complaints WHERE history_id = $1', [history_id])
    await query(client, 'DELETE FROM public.client_history_symptoms WHERE history_id = $1', [history_id])

    if (complaints.length > 0) {
        await query(client,
            `INSERT INTO public.client_history_complaints (history_id, complaint, severity, comment)
             SELECT $1, a.complaint, a.severity, a.comment
             FROM unnest($2::text[], $3::text[], $4::text[]) AS a(complaint, severity, comment)`,
            [history_id, complaints.map(c => c.complaint), complaints.map(c => c.severity), complaints.map(c => c.comment)]
        )
    }

    if (symptoms.length > 0) {
        await query(client,
            `INSERT INTO public.client_history_symptoms (history_id, symptom, rating, notes)
             SELECT $1, a.symptom, a.rating, a.notes
             FROM unnest($2::text[], $3::smallint[], $4::text[]) AS a(symptom, rating, notes)`,
            [history_id, symptoms.map(s => s.symptom), symptoms.map(s => s.rating), symptoms.map(s => s.notes)]
        )
    }
}

// The lifecycle trigger assigns the version, supersedes the previous active history
// and re-checks completeness. Returns null if the row is no longer a draft.
const publish = async (history_id, published_by, client) => {
    const { rows } = await query(client,
        `UPDATE public.client_histories
         SET status = 'active', published_by = $2
         WHERE history_id = $1 AND status = 'draft'
         RETURNING history_id`,
        [history_id, published_by]
    )
    return rows[0]?.history_id ?? null
}

// Inserts a draft with its answers and publishes it. Expects to run inside a
// transaction the caller controls (client registration).
const createPublished = async (client_id, history, user_id, client) => {
    const history_id = await insertDraft(client_id, history, user_id, client)
    await replaceAnswers(history_id, history, client)
    await publish(history_id, user_id, client)
    return history_id
}

// client must be a dedicated connection (req.dbClient), not the pool: BEGIN and
// COMMIT have to run on the same connection.
const saveDraft = async (client_id, history, user_id, client) => {
    await query(client, 'BEGIN')
    try {
        const { rows } = await query(client,
            `SELECT history_id
             FROM public.client_histories
             WHERE client_id = $1 AND status = 'draft'
             FOR UPDATE`,
            [client_id]
        )

        let history_id = rows[0]?.history_id
        if (history_id)
            await updateDraft(history_id, history, client)
        else
            history_id = await insertDraft(client_id, history, user_id, client)

        await replaceAnswers(history_id, history, client)
        await query(client, 'COMMIT')
        return history_id
    } catch (err) {
        await query(client, 'ROLLBACK')
        throw err
    }
}

const deleteDraft = async (client_id, client = pool) => {
    const { rows } = await query(client,
        `DELETE FROM public.client_histories
         WHERE client_id = $1 AND status = 'draft'
         RETURNING history_id`,
        [client_id]
    )
    return rows[0]?.history_id ?? null
}

export default {
    findByStatus,
    findById,
    createPublished,
    saveDraft,
    publish,
    deleteDraft
}
