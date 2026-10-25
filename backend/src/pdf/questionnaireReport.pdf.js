// backend/src/pdf/questionnaireReport.pdf.js
//
// Draws a session's questionnaire responses (BFI-2, WHO-5) as a PDF: the scores, then every
// question with the answer given and the score it contributes. The data comes from
// questionnaire.controller.js (the same assembly as GET /api/sessions/:id/questionnaires), and
// the layout helpers are shared with the session report so both PDFs look alike.

import PDFDocument from 'pdfkit'
import {
    MARGIN, TEXT_COLOR, MUTED_COLOR,
    ensureSpace, sectionHeading, subHeading, drawWrappedTable, formatDate,
} from './sessionReport.pdf.js'
import { BFI2_DOMAIN_NAMES } from '../validators/questionnaire.validators.js'

const NOTE = 'Questionnaire scores are self-reported measures, not medical diagnoses. Items marked (R) are ' +
    'reverse-keyed: they are scored as (scale minimum + scale maximum - answer) before averaging.'

// Statements and option labels are stored per language ({ en, ms, zh }); the report is in English.
function english(value) {
    if (value === null || value === undefined) return '—'
    if (typeof value === 'object') return value.en ?? Object.values(value)[0] ?? '—'
    return String(value)
}

function fmtScore(v, decimals = 2) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
    return Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(decimals)
}

function drawHeader(doc, data) {
    let cursorY = MARGIN
    doc.fontSize(16).font('Helvetica-Bold').fillColor(TEXT_COLOR)
        .text('Questionnaire Responses', MARGIN, cursorY)
    doc.font('Helvetica')
    cursorY += 26

    const sessionDate = data.session.startTime ? new Date(data.session.startTime).toLocaleString() : '—'
    const lines = [
        `Patient: ${data.patient.name ?? '—'}    Date of birth: ${formatDate(data.patient.dob)}    Gender: ${data.patient.gender ?? '—'}`,
        `Session date: ${sessionDate}    Technician: ${data.session.technicianName ?? '—'}`,
    ]
    doc.fontSize(10).fillColor(MUTED_COLOR)
    for (const line of lines) {
        doc.text(line, MARGIN, cursorY)
        cursorY += 14
    }
    doc.fillColor(TEXT_COLOR)
    return cursorY + 12
}

function answerLabel(q, value) {
    const option = (q.options ?? []).find((o) => o.value === value)
    return option ? `${value} — ${english(option.label)}` : String(value ?? '—')
}

function drawScores(doc, cursorY, q) {
    const usable = doc.page.width - MARGIN * 2
    if (q.code === 'who5') {
        const total = q.scores?.total
        cursorY = subHeading(doc, cursorY, 'Score')
        return drawWrappedTable(doc, cursorY, {
            colWidths: [usable * 0.6, usable * 0.4],
            header: ['Measure', 'Score'],
            rows: [
                ['Raw score (0–25)', fmtScore(total?.raw_score)],
                ['Well-being percentage (0–100)', fmtScore(total?.percentage_score)],
            ],
            align: ['left', 'right'],
        })
    }

    const domains = q.scores?.domains ?? []
    const facets = q.scores?.facets ?? []
    if (domains.length > 0) {
        cursorY = subHeading(doc, cursorY, `Domain scores (mean, ${q.scale_min}–${q.scale_max})`)
        cursorY = drawWrappedTable(doc, cursorY, {
            colWidths: [usable * 0.7, usable * 0.3],
            header: ['Domain', 'Mean'],
            rows: domains.map((d) => [d.domain_name ?? BFI2_DOMAIN_NAMES[d.domain] ?? d.domain, fmtScore(d.mean_score)]),
            align: ['left', 'right'],
        })
    }
    if (facets.length > 0) {
        cursorY = subHeading(doc, cursorY, `Facet scores (mean, ${q.scale_min}–${q.scale_max})`)
        cursorY = drawWrappedTable(doc, cursorY, {
            colWidths: [usable * 0.4, usable * 0.4, usable * 0.2],
            header: ['Domain', 'Facet', 'Mean'],
            rows: facets.map((f) => [BFI2_DOMAIN_NAMES[f.domain] ?? f.domain, f.facet, fmtScore(f.mean_score)]),
            align: ['left', 'left', 'right'],
        })
    }
    if (domains.length === 0 && facets.length === 0 && q.scores?.total) {
        cursorY = subHeading(doc, cursorY, 'Score')
        cursorY = drawWrappedTable(doc, cursorY, {
            colWidths: [usable * 0.6, usable * 0.4],
            header: ['Measure', 'Score'],
            rows: [['Raw score', fmtScore(q.scores.total.raw_score)], ['Mean', fmtScore(q.scores.total.mean_score)]],
            align: ['left', 'right'],
        })
    }
    return cursorY
}

function drawAnswers(doc, cursorY, q) {
    const usable = doc.page.width - MARGIN * 2
    const hasDomains = q.answers.some((a) => a.domain)
    cursorY = subHeading(doc, cursorY, `Responses (${q.answered_items} of ${q.expected_items})`)

    const answerRow = (a) => {
        const score = `${fmtScore(a.item_score)}${a.is_reverse_scored ? ' (R)' : ''}`
        const base = [String(a.question_no), english(a.statement)]
        const trait = hasDomains ? [[BFI2_DOMAIN_NAMES[a.domain] ?? a.domain, a.facet].filter(Boolean).join(' · ')] : []
        return [...base, ...trait, answerLabel(q, a.answer_value), score]
    }

    return drawWrappedTable(doc, cursorY, hasDomains
        ? {
            colWidths: [usable * 0.06, usable * 0.38, usable * 0.22, usable * 0.22, usable * 0.12],
            header: ['#', 'Statement', 'Domain · Facet', 'Answer', 'Score'],
            rows: q.answers.map(answerRow),
            align: ['right', 'left', 'left', 'left', 'right'],
        }
        : {
            colWidths: [usable * 0.06, usable * 0.5, usable * 0.32, usable * 0.12],
            header: ['#', 'Statement', 'Answer', 'Score'],
            rows: q.answers.map(answerRow),
            align: ['right', 'left', 'left', 'right'],
        })
}

function drawQuestionnaire(doc, cursorY, q) {
    cursorY = sectionHeading(doc, cursorY, q.name ?? q.code ?? 'Questionnaire')
    if (!q.answered_items) {
        doc.fontSize(9).fillColor(MUTED_COLOR).text('Not answered for this session.', MARGIN, cursorY)
        doc.fillColor(TEXT_COLOR)
        return cursorY + 20
    }
    const submitted = q.submitted_at ? new Date(q.submitted_at).toLocaleString() : '—'
    doc.fontSize(9).fillColor(MUTED_COLOR)
        .text(`Submitted ${submitted}${q.is_complete ? '' : '  ·  incomplete'}`, MARGIN, cursorY)
    doc.fillColor(TEXT_COLOR)
    cursorY += 16
    cursorY = drawScores(doc, cursorY, q)
    return drawAnswers(doc, cursorY, q)
}

/**
 * Builds the questionnaire PDF. `data` is { patient: { name, dob, gender },
 * session: { startTime, technicianName }, questionnaires } with questionnaires in the shape
 * GET /api/sessions/:id/questionnaires returns. Each questionnaire starts on its own page.
 * Returns the pdfkit document; the caller pipes it and calls end().
 */
export function buildQuestionnaireReportPdf(data) {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })

    let cursorY = drawHeader(doc, data)
    data.questionnaires.forEach((q, i) => {
        if (i > 0) {
            doc.addPage()
            cursorY = MARGIN
        }
        cursorY = drawQuestionnaire(doc, cursorY, q)
    })

    cursorY = ensureSpace(doc, cursorY, 30)
    doc.fontSize(8).fillColor(MUTED_COLOR)
        .text(NOTE, MARGIN, cursorY, { width: doc.page.width - MARGIN * 2 })
    doc.fillColor(TEXT_COLOR)
    return doc
}

export default { buildQuestionnaireReportPdf }
