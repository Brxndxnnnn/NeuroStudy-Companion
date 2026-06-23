import pool from '../config/db.js';
import query from '../utils/query.js';

const findAll = async (client = pool) => {
    const { rows } = await query(client, 
        `SELECT * FROM questionnaires ORDER BY created_at DESC, questionnaire_id DESC`
    );
    return rows;
}

const findById = async (questionnaire_id, client = pool) => {
    const { rows } = await query(client, 
        `SELECT * FROM questionnaires WHERE questionnaire_id = $1`, [questionnaire_id]
    );
    return rows;
}

const findAllQuestions = async (languages, client = pool) => {
    const [en, ms, cn] = languages
    let sql = `SELECT question_id, question_no, domain, is_reverse_scored`
    if (languages.length === 0) {
        sql += `, statement` // Default to ALL if no languages specified
    } else {
        if (en) sql += `, statement->>'${en}' as ${en}_statement`
        if (ms) sql += `, statement->>'${ms}' as ${ms}_statement`
        if (cn) sql += `, statement->>'${cn}' as ${cn}_statement`
    }
    sql += ` FROM questionnaire_questions ORDER BY question_no ASC`
    const { rows } = await query(client, sql);
    return rows;
}

const findQuestionsByQuestionnaireId = async (questionnaire_id, languages, client = pool) => {
    console.log('findQuestionsByQuestionnaireId - questionnaire_id:', questionnaire_id)
    console.log('findQuestionsByQuestionnaireId - languages:', languages)
    const [en, ms, cn] = languages
    let sql = `SELECT question_id, question_no, domain, is_reverse_scored`
    if (languages.length === 0) {
        sql += `, statement` // Default to ALL if no languages specified
    } else {
        if (en) sql += `, statement->>'${en}' as ${en}_statement`
        if (ms) sql += `, statement->>'${ms}' as ${ms}_statement`
        if (cn) sql += `, statement->>'${cn}' as ${cn}_statement`
    }
    sql += ` FROM questionnaire_questions WHERE questionnaire_id = $1 ORDER BY question_no ASC`
    console.log('Constructed SQL query:', sql)
    const { rows } = await query(client, sql, [questionnaire_id]);
    return rows;
}

export default { findAll, findById, findAllQuestions, findQuestionsByQuestionnaireId }