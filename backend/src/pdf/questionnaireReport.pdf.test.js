import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildQuestionnaireReportPdf } from './questionnaireReport.pdf.js'

const toBuffer = (doc) => new Promise((resolve) => {
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.end()
})

const DOMAINS = ['E', 'A', 'C', 'N', 'O']
const bfi2 = {
    code: 'bfi2', name: 'BFI-2', scale_min: 1, scale_max: 5, expected_items: 60, answered_items: 60,
    is_complete: true, submitted_at: '2026-10-15T08:10:00Z',
    options: [1, 2, 3, 4, 5].map((value) => ({ value, label: { en: `Label ${value}` } })),
    scores: {
        total: null,
        domains: DOMAINS.map((domain) => ({ domain, mean_score: 3.25 })),
        facets: DOMAINS.map((domain) => ({ domain, facet: 'Facet', mean_score: 3.5 })),
    },
    answers: Array.from({ length: 60 }, (_, i) => ({
        question_no: i + 1, statement: { en: `Statement ${i + 1}`, ms: 'x', zh: 'x' },
        domain: DOMAINS[i % 5], facet: 'Facet', is_reverse_scored: i % 2 === 0, answer_value: 4, item_score: i % 2 === 0 ? 2 : 4,
    })),
}
const who5 = {
    code: 'who5', name: 'WHO-5', scale_min: 0, scale_max: 5, expected_items: 5, answered_items: 0,
    is_complete: false, submitted_at: null, options: null, scores: null, answers: [],
}
const base = {
    patient: { name: 'Test Client', dob: new Date(2015, 4, 2), gender: 'Male' },
    session: { startTime: '2026-10-15T08:00:00Z', technicianName: 'Tech Alice' },
}

describe('questionnaireReport.pdf', () => {
    test('renders a 60-item BFI-2 across pages and an unanswered WHO-5', async () => {
        const pdf = await toBuffer(buildQuestionnaireReportPdf({ ...base, questionnaires: [bfi2, who5] }))
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
        const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length
        assert.ok(pages >= 3, `expected the 60 answers to spill onto several pages, got ${pages}`)
    })

    test('copes with plain-string statements and unknown option values', async () => {
        const q = { ...bfi2, options: null, answers: bfi2.answers.map((a) => ({ ...a, statement: 'Plain' })) }
        const pdf = await toBuffer(buildQuestionnaireReportPdf({ ...base, questionnaires: [q] }))
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    })
})
