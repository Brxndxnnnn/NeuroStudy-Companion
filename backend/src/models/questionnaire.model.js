import pool from '../config/db.js';
import query from '../utils/query.js';
import { STATEMENT_LANGUAGES } from '../validators/questionnaire.validators.js';

// Fixed SQL fragments per language: language codes come from the query string, so they
// are looked up here rather than interpolated into the SQL.
const STATEMENT_COLUMNS = Object.freeze(Object.fromEntries(
    STATEMENT_LANGUAGES.map(lang => [lang, `statement->>'${lang}' AS ${lang}_statement`])
));

const findAll = async (client = pool) => {
    const { rows } = await query(client,
        `SELECT * FROM questionnaires ORDER BY display_order ASC NULLS LAST, created_at ASC`
    );
    return rows;
}

const findById = async (questionnaire_id, client = pool) => {
    const { rows } = await query(client,
        `SELECT * FROM questionnaires WHERE questionnaire_id = $1`, [questionnaire_id]
    );
    return rows;
}

// languages: [] returns the full multi-language `statement` object; otherwise one
// `<lang>_statement` column per requested language.
const findQuestionsByQuestionnaireId = async (questionnaire_id, languages, client = pool) => {
    const statementColumns = languages.length === 0
        ? ['statement']
        : languages.map(lang => {
            const column = STATEMENT_COLUMNS[lang];
            if (!column)
                throw new Error(`Unsupported statement language: ${lang}`);
            return column;
        });
    const { rows } = await query(client,
        `SELECT question_id, question_no, domain, facet, is_reverse_scored, ${statementColumns.join(', ')}
         FROM questionnaire_questions
         WHERE questionnaire_id = $1
         ORDER BY question_no ASC`,
        [questionnaire_id]
    );
    return rows;
}

const hasAnswers = async (session_id, questionnaire_id, client = pool) => {
    const { rows } = await query(client,
        `SELECT EXISTS (
            SELECT 1 FROM session_questionnaire_responses
            WHERE session_id = $1 AND questionnaire_id = $2
         ) AS answered`,
        [session_id, questionnaire_id]
    );
    return rows[0].answered;
}

// All answers in one transaction, so a submission is never half-saved. clinic_id is not
// sent: the database trigger copies it from the session (024).
// client must be a dedicated connection (req.dbClient), not the pool.
const insertAnswers = async (session_id, questionnaire_id, answers, client) => {
    await query(client, 'BEGIN');
    try {
        const { rows } = await query(client,
            `INSERT INTO session_questionnaire_responses (session_id, questionnaire_id, question_id, response_value)
             SELECT $1, $2, a.question_id, to_jsonb(a.answer_value)
             FROM unnest($3::uuid[], $4::integer[]) AS a(question_id, answer_value)
             RETURNING session_id, questionnaire_id, question_id, response_value, clinic_id`,
            [session_id, questionnaire_id, answers.map(a => a.question_id), answers.map(a => a.answer_value)]
        );
        await query(client, 'COMMIT');
        return rows;
    } catch (err) {
        await query(client, 'ROLLBACK');
        throw err;
    }
}

// Every questionnaire with its item count, for listing a session's surveys including
// ones not answered yet.
const listWithItemCounts = async (client = pool) => {
    const { rows } = await query(client,
        `SELECT
            q.questionnaire_id,
            q.code,
            q.name,
            q.scale_min,
            q.scale_max,
            q.display_order,
            (SELECT COUNT(*)::integer FROM questionnaire_questions qq
             WHERE qq.questionnaire_id = q.questionnaire_id) AS expected_items
         FROM questionnaires q
         ORDER BY q.display_order ASC NULLS LAST, q.created_at ASC`
    );
    return rows;
}

// A session's answers with the score each contributes (reverse-keyed items flipped the
// same way as session_questionnaire_scores).
const findSessionAnswers = async (session_id, client = pool) => {
    const { rows } = await query(client,
        `SELECT
            r.questionnaire_id,
            r.question_id,
            qq.question_no,
            qq.statement,
            qq.domain,
            qq.facet,
            qq.is_reverse_scored,
            (r.response_value #>> '{}')::integer AS answer_value,
            CASE WHEN qq.is_reverse_scored
                 THEN q.scale_min + q.scale_max - (r.response_value #>> '{}')::integer
                 ELSE (r.response_value #>> '{}')::integer
            END AS item_score,
            r.created_at
         FROM session_questionnaire_responses r
         JOIN questionnaire_questions qq ON qq.question_id = r.question_id
         JOIN questionnaires q ON q.questionnaire_id = r.questionnaire_id
         WHERE r.session_id = $1
         ORDER BY qq.question_no ASC`,
        [session_id]
    );
    return rows;
}

// Rows from the scoring view (024); questionnaire_id optionally narrows to one.
const findSessionScores = async (session_id, questionnaire_id = null, client = pool) => {
    const { rows } = await query(client,
        `SELECT questionnaire_id, questionnaire_code, score_level, domain, facet,
                answered_items, expected_items, is_complete,
                raw_score, mean_score::float8 AS mean_score, percentage_score::float8 AS percentage_score
         FROM session_questionnaire_scores
         WHERE session_id = $1 AND ($2::uuid IS NULL OR questionnaire_id = $2::uuid)
         ORDER BY questionnaire_id, score_level, domain NULLS FIRST, facet NULLS FIRST`,
        [session_id, questionnaire_id]
    );
    return rows;
}

export default {
    findAll,
    findById,
    findQuestionsByQuestionnaireId,
    hasAnswers,
    insertAnswers,
    listWithItemCounts,
    findSessionAnswers,
    findSessionScores
}
