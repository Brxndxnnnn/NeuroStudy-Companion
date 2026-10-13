// backend/src/pdf/sessionReport.pdf.js
//
// Draws the PDF report (ITP2 requirement #6) from the data report.service.js assembles. Plain
// pdfkit — no React/JSX, no headless browser — see the ITP2 PDF-report plan for why (the backend
// runs on a memory-constrained shared droplet; pdfkit is pure JS with no browser process).
//
// Layout is driven by an explicit `cursorY` tracked through the whole build, rather than relying on
// pdfkit's automatic text-flow cursor — this file mixes hand-drawn charts (which don't move
// pdfkit's own cursor) with text/tables, so one explicit, predictable position is simpler to reason
// about than two different flow mechanisms fighting each other.

import PDFDocument from 'pdfkit'

const MARGIN = 40
const CHANNEL_COLORS = { Fp1: '#3B82F6', Fp2: '#22C55E', T3: '#E67E22', T4: '#A78BFA' }
const TEXT_COLOR = '#111827'
const MUTED_COLOR = '#6B7280'
const HEADER_BG = '#1E2A3C'
const ROW_BG = '#F4F6F8'
const BORDER_COLOR = '#D9DEE4'
const ALPHA_BAND = [8, 12] // Hz — shaded on every spectrum chart

function fmt(v, decimals = 2) {
    return v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(decimals)
}

function ensureSpace(doc, cursorY, needed) {
    const bottom = doc.page.height - MARGIN
    if (cursorY + needed > bottom) {
        doc.addPage()
        return MARGIN
    }
    return cursorY
}

function sectionHeading(doc, cursorY, text) {
    cursorY = ensureSpace(doc, cursorY, 24)
    doc.fontSize(12).fillColor(TEXT_COLOR).font('Helvetica-Bold')
        .text(text, MARGIN, cursorY, { width: doc.page.width - MARGIN * 2 })
    doc.font('Helvetica')
    return cursorY + 20
}

function subHeading(doc, cursorY, text) {
    doc.fontSize(9).fillColor(MUTED_COLOR).font('Helvetica-Bold')
        .text(text, MARGIN, cursorY)
    doc.font('Helvetica').fillColor(TEXT_COLOR)
    return cursorY + 14
}

// ── Generic drawing helpers ─────────────────────────────────────────────────────────────────────
function scale(value, [lo, hi], size, invert = false) {
    if (hi === lo) return invert ? size / 2 : 0
    const t = (value - lo) / (hi - lo)
    return invert ? size - t * size : t * size
}

function domainOf(values, pad = 0.1) {
    const valid = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v))
    if (valid.length === 0) return [0, 1]
    let lo = Math.min(...valid)
    let hi = Math.max(...valid)
    if (lo === hi) { lo -= 1; hi += 1 }
    const span = hi - lo
    return [lo - span * pad, hi + span * pad]
}

function drawBox(doc, x, y, w, h) {
    doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke()
}

function drawLineSeries(doc, points, x, y, w, h, xDomain, yDomain, color) {
    const real = points.filter((p) => p.v !== null && p.v !== undefined && !Number.isNaN(p.v))
    if (real.length < 2) return
    doc.strokeColor(color).lineWidth(0.6)
    real.forEach((p, i) => {
        const px = x + scale(p.t, xDomain, w)
        const py = y + scale(p.v, yDomain, h, true)
        if (i === 0) doc.moveTo(px, py)
        else doc.lineTo(px, py)
    })
    doc.stroke()
}

// One lane per channel, auto-gain-scaled per channel (like the live bridge chart) so a quiet
// channel doesn't just read as a flat line next to a noisier one.
function drawWaveformLanes(doc, cursorY, waveform) {
    const laneHeight = 46
    const laneGap = 4
    const chartX = MARGIN + 36 // room for the channel label
    const chartW = doc.page.width - MARGIN * 2 - 36

    cursorY = ensureSpace(doc, cursorY, waveform.length * (laneHeight + laneGap) + 16)
    cursorY = subHeading(doc, cursorY, 'Raw EEG (filtered, µV)')

    for (const ch of waveform) {
        const y = cursorY
        drawBox(doc, chartX, y, chartW, laneHeight)
        doc.fontSize(8).fillColor(CHANNEL_COLORS[ch.channel] ?? TEXT_COLOR)
            .text(ch.channel, MARGIN, y + laneHeight / 2 - 5, { width: 32 })

        if (ch.points.length >= 2) {
            const t0 = ch.points[0].t
            const normalized = ch.points.map((p) => ({ t: p.t - t0, v: p.v }))
            const xDomain = [0, Math.max(0.001, normalized[normalized.length - 1].t)]
            const yDomain = domainOf(normalized.map((p) => p.v))
            drawLineSeries(doc, normalized, chartX, y, chartW, laneHeight, xDomain, yDomain, CHANNEL_COLORS[ch.channel] ?? TEXT_COLOR)
        } else {
            doc.fontSize(7).fillColor(MUTED_COLOR).text('No samples', chartX + 4, y + laneHeight / 2 - 4)
        }
        cursorY = y + laneHeight + laneGap
    }
    doc.fillColor(TEXT_COLOR)
    return cursorY + 6
}

// Small 2x2 grid of Power-vs-Frequency charts, one per channel, with the alpha band (8-12Hz)
// shaded — the client template's "Power Frequency chart", restricted to our 4 real electrodes.
function drawSpectrumGrid(doc, cursorY, spectra) {
    const chartW = (doc.page.width - MARGIN * 2 - 16) / 2
    const chartH = 120
    const rowGap = 10
    const colGap = 16

    cursorY = ensureSpace(doc, cursorY, chartH * 2 + rowGap + 20)
    cursorY = subHeading(doc, cursorY, 'Power vs Frequency (0–15Hz, alpha band 8–12Hz shaded)')

    const gridTop = cursorY
    spectra.forEach((spec, i) => {
        const col = i % 2
        const row = Math.floor(i / 2)
        const x = MARGIN + col * (chartW + colGap)
        const y = gridTop + row * (chartH + rowGap)

        drawBox(doc, x, y, chartW, chartH)
        doc.fontSize(8).fillColor(CHANNEL_COLORS[spec.channel] ?? TEXT_COLOR)
            .text(spec.channel, x + 4, y + 2)

        if (spec.points.length < 2) {
            doc.fontSize(7).fillColor(MUTED_COLOR).text('No samples', x + 4, y + chartH / 2)
            return
        }

        const xDomain = [0, 15]
        const yDomain = [0, Math.max(...spec.points.map((p) => p.powerUvSq)) * 1.1 || 1]

        // Alpha band shading, drawn behind the line.
        const shadeX = x + scale(ALPHA_BAND[0], xDomain, chartW)
        const shadeW = scale(ALPHA_BAND[1], xDomain, chartW) - scale(ALPHA_BAND[0], xDomain, chartW)
        doc.fillColor(CHANNEL_COLORS[spec.channel] ?? '#999').fillOpacity(0.12)
            .rect(shadeX, y, shadeW, chartH).fill()
        doc.fillOpacity(1).fillColor(TEXT_COLOR)

        drawLineSeries(
            doc,
            spec.points.map((p) => ({ t: p.freqHz, v: p.powerUvSq })),
            x, y, chartW, chartH, xDomain, yDomain, CHANNEL_COLORS[spec.channel] ?? TEXT_COLOR
        )
    })

    return gridTop + Math.ceil(spectra.length / 2) * (chartH + rowGap) + 6
}

// ── Tables ───────────────────────────────────────────────────────────────────────────────────────
function drawTable(doc, cursorY, { colWidths, header, rows, rowHeight = 16 }) {
    const totalWidth = colWidths.reduce((a, b) => a + b, 0)
    cursorY = ensureSpace(doc, cursorY, rowHeight * (rows.length + 1) + 4)

    let x = MARGIN
    doc.fontSize(8)
    header.forEach((cell, i) => {
        doc.rect(x, cursorY, colWidths[i], rowHeight).fill(HEADER_BG)
        doc.fillColor('#FFFFFF').text(String(cell), x + 4, cursorY + 4, { width: colWidths[i] - 8 })
        x += colWidths[i]
    })
    cursorY += rowHeight

    rows.forEach((row, rIdx) => {
        x = MARGIN
        const bg = rIdx % 2 === 0 ? ROW_BG : '#FFFFFF'
        row.forEach((cell, i) => {
            doc.rect(x, cursorY, colWidths[i], rowHeight).fillAndStroke(bg, BORDER_COLOR)
            doc.fillColor(TEXT_COLOR).text(cell, x + 4, cursorY + 4, { width: colWidths[i] - 8 })
            x += colWidths[i]
        })
        cursorY += rowHeight
    })

    doc.strokeColor(BORDER_COLOR).rect(MARGIN, cursorY - rowHeight * (rows.length + 1), totalWidth, rowHeight * (rows.length + 1)).stroke()
    return cursorY + 10
}

function drawAlphaTable(doc, cursorY, alphaTable) {
    cursorY = subHeading(doc, cursorY, 'POWER (Alpha, µV²)')
    const usable = doc.page.width - MARGIN * 2
    const colWidths = [usable * 0.25, usable * 0.25, usable * 0.25, usable * 0.25]
    const byChannel = Object.fromEntries(alphaTable.map((r) => [r.channel, r.value]))
    return drawTable(doc, cursorY, {
        colWidths,
        header: ['Left', 'Value', 'Right', 'Value'],
        rows: [
            ['Fp1', fmt(byChannel.Fp1), 'Fp2', fmt(byChannel.Fp2)],
            ['T3', fmt(byChannel.T3), 'T4', fmt(byChannel.T4)],
        ],
    })
}

function drawAbsoluteTable(doc, cursorY, absoluteTable) {
    cursorY = subHeading(doc, cursorY, 'Absolute band power (µV²)')
    const usable = doc.page.width - MARGIN * 2
    const colWidths = [usable * 0.16, usable * 0.14, usable * 0.14, usable * 0.14, usable * 0.14, usable * 0.14, usable * 0.14]
    return drawTable(doc, cursorY, {
        colWidths,
        header: ['Channel', 'Delta', 'Theta', 'Alpha', 'Beta', 'Gamma', 'Total'],
        rows: absoluteTable.map((r) => [r.channel, fmt(r.delta), fmt(r.theta), fmt(r.alpha), fmt(r.beta), fmt(r.gamma), fmt(r.total)]),
    })
}

// ── Header ───────────────────────────────────────────────────────────────────────────────────────
function drawReportHeader(doc, data) {
    let cursorY = MARGIN
    doc.fontSize(16).font('Helvetica-Bold').fillColor(TEXT_COLOR)
        .text('EEG Session Report', MARGIN, cursorY)
    doc.font('Helvetica')
    cursorY += 26

    const sessionDate = data.session.startTime ? new Date(data.session.startTime).toLocaleString() : '—'
    const lines = [
        `Patient: ${data.patient.name ?? '—'}    Age: ${data.patient.age ?? '—'}    Gender: ${data.patient.gender ?? '—'}`,
        `Session date: ${sessionDate}    Technician: ${data.session.technicianName ?? '—'}`,
    ]
    doc.fontSize(10).fillColor(MUTED_COLOR)
    for (const line of lines) {
        doc.text(line, MARGIN, cursorY)
        cursorY += 14
    }
    doc.fillColor(TEXT_COLOR)
    return cursorY + 16
}

function drawBlock(doc, cursorY, block) {
    cursorY = sectionHeading(doc, cursorY, block.label)
    if (!block.available) {
        doc.fontSize(9).fillColor(MUTED_COLOR)
            .text('No data available for this phase.', MARGIN, cursorY)
        doc.fillColor(TEXT_COLOR)
        return cursorY + 20
    }
    cursorY = drawWaveformLanes(doc, cursorY, block.waveform)
    cursorY = drawAlphaTable(doc, cursorY, block.alphaTable)
    cursorY = drawSpectrumGrid(doc, cursorY, block.spectra)
    cursorY = drawAbsoluteTable(doc, cursorY, block.absoluteTable)
    return cursorY
}

// ── Narrative helpers (client history + commentary) ─────────────────────────────────────────────
// Free text can run past a page, so these let pdfkit's own flow paginate and then pick the cursor
// back up from doc.y — unlike the fixed-height charts/tables above, whose size is known up front.
function paragraph(doc, cursorY, text, { size = 10, color = TEXT_COLOR, gap = 8 } = {}) {
    cursorY = ensureSpace(doc, cursorY, size * 3)
    doc.fontSize(size).fillColor(color).font('Helvetica')
        .text(text, MARGIN, cursorY, { width: doc.page.width - MARGIN * 2, lineGap: 1.5 })
    doc.fillColor(TEXT_COLOR)
    return doc.y + gap
}

function labelledText(doc, cursorY, label, text) {
    cursorY = ensureSpace(doc, cursorY, 40)
    doc.fontSize(9).fillColor(MUTED_COLOR).font('Helvetica-Bold').text(label, MARGIN, cursorY)
    doc.font('Helvetica').fillColor(TEXT_COLOR)
    return paragraph(doc, doc.y + 2, text)
}

function formatDate(value) {
    if (!value) return '—'
    // intake_date arrives as 'YYYY-MM-DD' text; a client's dob as a Date.
    if (typeof value === 'string') {
        const [y, m, d] = value.slice(0, 10).split('-')
        return y && m && d ? `${d}/${m}/${y}` : value
    }
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return '—'
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

// Like drawTable, but each row is as tall as its wrapped text needs (comments/notes are free text).
function drawWrappedTable(doc, cursorY, { colWidths, header, rows, align = [] }) {
    const pad = 4
    const heightOf = (cells) => Math.max(
        ...cells.map((c, i) => doc.fontSize(8).heightOfString(String(c), { width: colWidths[i] - pad * 2 }))
    ) + pad * 2

    const drawRow = (cells, y, h, bg, textColor, isHeader) => {
        let x = MARGIN
        cells.forEach((cell, i) => {
            if (isHeader) doc.rect(x, y, colWidths[i], h).fill(HEADER_BG)
            else doc.rect(x, y, colWidths[i], h).fillAndStroke(bg, BORDER_COLOR)
            doc.fontSize(8).fillColor(textColor)
                .text(String(cell), x + pad, y + pad, { width: colWidths[i] - pad * 2, align: align[i] ?? 'left' })
            x += colWidths[i]
        })
    }

    const headerH = heightOf(header)
    cursorY = ensureSpace(doc, cursorY, headerH + 30)
    drawRow(header, cursorY, headerH, null, '#FFFFFF', true)
    cursorY += headerH

    rows.forEach((row, rIdx) => {
        const h = heightOf(row)
        if (cursorY + h > doc.page.height - MARGIN) {
            doc.addPage()
            cursorY = MARGIN
            drawRow(header, cursorY, headerH, null, '#FFFFFF', true)
            cursorY += headerH
        }
        drawRow(row, cursorY, h, rIdx % 2 === 0 ? ROW_BG : '#FFFFFF', TEXT_COLOR, false)
        cursorY += h
    })
    doc.fillColor(TEXT_COLOR)
    return cursorY + 12
}

// ── Client intake history (Client EEG & Tap Questionnaire) ──────────────────────────────────────
const HISTORY_TEXT_SECTIONS = [
    ['medical_history', 'Medical history / rehabilitation / operations'],
    ['cognitive_behavioural_profile', 'Cognitive / behavioural profile'],
    ['language_communication', 'Language / communication'],
    ['social_observations', 'Social skills / observations'],
    ['treatment_goals', 'Goal of the treatment'],
]
const COMPLAINT_LABELS = {
    headache: 'Headache',
    medication: 'Medication',
    sleep_quality: 'Sleep quality',
    concentration: 'Concentration',
    motor_activity: 'Motor activity',
    pain: 'Pain',
}
const SYMPTOM_LABELS = { concentration: 'Concentration', motivation: 'Motivation', social_skills: 'Social skills' }
const SEVERITY_COLUMNS = ['not_affected', 'little_affected', 'strongly_affected']

function drawClientHistory(doc, cursorY, history) {
    cursorY = sectionHeading(doc, cursorY, 'Client intake history')
    if (!history) {
        doc.fontSize(9).fillColor(MUTED_COLOR)
            .text('No intake history was recorded for this client.', MARGIN, cursorY)
        doc.fillColor(TEXT_COLOR)
        return cursorY + 24
    }

    cursorY = paragraph(doc, cursorY, `Date of intake & measurement: ${formatDate(history.intake_date)}`, { color: MUTED_COLOR })
    for (const [key, label] of HISTORY_TEXT_SECTIONS)
        cursorY = labelledText(doc, cursorY, label, history[key] || '—')

    cursorY = ensureSpace(doc, cursorY, 80)
    cursorY = subHeading(doc, cursorY, 'In the last 4 weeks, how much did the client feel affected by the following complaints?')
    const usable = doc.page.width - MARGIN * 2
    const byComplaint = Object.fromEntries((history.complaints ?? []).map((c) => [c.complaint, c]))
    cursorY = drawWrappedTable(doc, cursorY, {
        colWidths: [usable * 0.17, usable * 0.12, usable * 0.12, usable * 0.14, usable * 0.45],
        align: ['left', 'center', 'center', 'center', 'left'],
        header: ['Complaint', 'Not affected', 'Little affected', 'Strongly affected', 'Comments'],
        rows: Object.entries(COMPLAINT_LABELS).map(([key, label]) => {
            const c = byComplaint[key]
            return [label, ...SEVERITY_COLUMNS.map((sev) => (c?.severity === sev ? 'X' : '')), c?.comment || '']
        }),
    })

    cursorY = labelledText(doc, cursorY, 'School education / study', history.school_education || '—')
    cursorY = labelledText(doc, cursorY, 'Professional education / actual work', history.occupation || '—')
    cursorY = labelledText(doc, cursorY, 'Hobbies', history.hobbies || '—')

    cursorY = ensureSpace(doc, cursorY, 80)
    cursorY = subHeading(doc, cursorY, 'Symptoms (rated 1–10)')
    const bySymptom = Object.fromEntries((history.symptoms ?? []).map((x) => [x.symptom, x]))
    return drawWrappedTable(doc, cursorY, {
        colWidths: [usable * 0.2, usable * 0.15, usable * 0.65],
        align: ['left', 'center', 'left'],
        header: ['Symptom', 'Expression', 'Notes'],
        rows: Object.entries(SYMPTOM_LABELS).map(([key, label]) => {
            const x = bySymptom[key]
            return [label, x ? `${x.rating} / 10` : '—', x?.notes || '']
        }),
    })
}

// ── Technician commentary (Section A report) ────────────────────────────────────────────────────
const EEG_NOTE = 'Note: During a neurofeedback pre-measurement, results are stored and analyzed in the form of an EEG and ' +
    'QEEG. This does not replace the examination by a neurologist. We can support the diagnosis with the help of the ' +
    'analysis, it does not replace the medical and neurological diagnosis.'

function drawCommentary(doc, cursorY, data) {
    const c = data.commentary
    cursorY = sectionHeading(doc, cursorY, 'Report')
    cursorY = paragraph(doc, cursorY, `Dear ${data.patient.name ?? 'Client'},`)
    cursorY = paragraph(doc, cursorY, `Thank you for visiting us${data.session.clinicName ? ` in ${data.session.clinicName}` : ''}.`)

    cursorY = subHeading(doc, cursorY, 'General data')
    cursorY = paragraph(doc, cursorY, `Name: ${data.patient.name ?? '—'}\nDate of birth: ${formatDate(data.patient.dob)}`)

    cursorY = labelledText(doc, cursorY, 'Anamnesis', c.anamnesis)

    cursorY = ensureSpace(doc, cursorY, 60)
    doc.fontSize(12).font('Helvetica-Bold').fillColor(TEXT_COLOR).text('EEG Pre Measurement', MARGIN, cursorY)
    doc.font('Helvetica')
    cursorY = paragraph(doc, doc.y + 4, EEG_NOTE, { size: 8, color: MUTED_COLOR })
    cursorY = labelledText(doc, cursorY, 'EEG premeasurement', c.eeg_premeasurement)
    cursorY = labelledText(doc, cursorY, 'Resting state recording with eyes closed', c.eeg_eyes_closed)
    cursorY = labelledText(doc, cursorY, 'Recording with eyes open', c.eeg_eyes_open)
    cursorY = labelledText(doc, cursorY, 'Recording during performance of a cognitively responsive task', c.eeg_cognitive_task)
    cursorY = labelledText(doc, cursorY, 'Conclusion', c.eeg_conclusion)
    cursorY = labelledText(doc, cursorY, 'Prognostic estimation', c.prognostic_estimation)

    cursorY = paragraph(doc, cursorY, 'If you have any questions, please do not hesitate to contact us.')
    return paragraph(doc, cursorY, `With kind regards,\n${data.session.technicianName ?? ''}`)
}

/**
 * Builds the full report as a PDFDocument. The caller is responsible for piping it to a response
 * (`doc.pipe(res)`) and calling `doc.end()` once this returns.
 *
 * Order: patient header and client intake history, then one page per EEG block, then the
 * technician's commentary.
 */
export function buildSessionReportPdf(data) {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })

    const cursorY = drawReportHeader(doc, data)
    drawClientHistory(doc, cursorY, data.history)

    for (const block of data.blocks) {
        doc.addPage()
        drawBlock(doc, MARGIN, block)
    }

    if (data.commentary) {
        doc.addPage()
        drawCommentary(doc, MARGIN, data)
    }

    return doc
}

export default { buildSessionReportPdf }
