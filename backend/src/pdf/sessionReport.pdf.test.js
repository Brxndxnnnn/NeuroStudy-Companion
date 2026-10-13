import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionReportPdf } from './sessionReport.pdf.js'

const toBuffer = (doc) => new Promise((resolve) => {
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.end()
})

const history = {
    intake_date: '2026-10-13',
    medical_history: 'Early learning difficulties.',
    cognitive_behavioural_profile: 'Distractible.',
    language_communication: 'Right-hand dominant.',
    social_observations: 'Shy.',
    treatment_goals: 'Improve focus.',
    school_education: 'Private school',
    occupation: '-',
    hobbies: 'Cycling',
    complaints: [{ complaint: 'sleep_quality', severity: 'strongly_affected', comment: 'Sleeps at 1am' }],
    symptoms: [{ symptom: 'motivation', rating: 6, notes: 'Depends on interest' }],
}
const commentary = {
    anamnesis: 'ANAMNESIS-TEXT', eeg_premeasurement: 'PRE-TEXT', eeg_eyes_closed: 'CLOSED-TEXT',
    eeg_eyes_open: 'OPEN-TEXT', eeg_cognitive_task: 'TASK-TEXT', eeg_conclusion: 'CONCL-TEXT',
    prognostic_estimation: 'PROG-TEXT',
}
const base = {
    patient: { name: 'Test Client', dob: new Date(2015, 4, 2), age: 11, gender: 'Male' },
    session: { startTime: '2026-10-13T02:00:00Z', technicianName: 'Tech Alice', clinicName: 'Clinic A' },
    blocks: [{ key: 'baseline1_closed', label: 'Baseline 1 — Eyes Closed', available: false }],
}

describe('sessionReport.pdf', () => {
    test('renders history, EEG blocks and commentary into one PDF', async () => {
        const pdf = await toBuffer(buildSessionReportPdf({ ...base, history, commentary }))
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    })

    test('renders without a history (backfilled or missing)', async () => {
        const pdf = await toBuffer(buildSessionReportPdf({ ...base, history: null, commentary }))
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    })

    test('long free text paginates instead of throwing', async () => {
        const long = 'word '.repeat(4000)
        const pdf = await toBuffer(buildSessionReportPdf({
            ...base, history: { ...history, medical_history: long }, commentary: { ...commentary, anamnesis: long },
        }))
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    })
})
