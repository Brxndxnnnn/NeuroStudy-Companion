// backend/src/services/report.service.js
//
// Assembles the data model backend/src/pdf/sessionReport.pdf.js draws into a PDF (ITP2 requirement
// #6). Reuses the existing session-results model layer (session.model.js) rather than new raw SQL —
// see the ITP2 PDF-report plan for why each table is in/out of scope.

import sessionModel from '../models/session.model.js'
import { computePowerSpectrum } from '../utils/spectrum.js'
import { ConflictError, NotFoundError } from '../utils/AppError.js'

const CHANNELS = [
    { label: 'Fp1', sampleKey: 'fp1_left_front', bandPrefix: 'fp1' },
    { label: 'Fp2', sampleKey: 'fp2_right_front', bandPrefix: 'fp2' },
    { label: 'T3', sampleKey: 't3_left_temporal', bandPrefix: 't3' },
    { label: 'T4', sampleKey: 't4_right_temporal', bandPrefix: 't4' },
]
const BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma']

// Fixed phase durations (seconds) — fallback only when a phase event's hidden_at hasn't been
// written AND there's no later phase event to infer the boundary from (e.g. the session's very
// last phase). Mirrors DbUploader.PhaseDurationSeconds in
// neuuro_bridge/NeuuroBridge.Core/DbUploader.cs — keep both in sync if the protocol timing changes.
const PHASE_FALLBACK_SECONDS = {
    countdown_pre: 5, countdown_images: 5, countdown_post: 5,
    countdown_b1: 3, countdown_b2: 3,
    baseline1_closed: 60, baseline1_open: 60, baseline2_closed: 60, baseline2_open: 60,
}

// Points per channel kept for the printed waveform chart — a 60s phase at 250Hz is 15,000 samples,
// far denser than a static line on paper needs or can even visually resolve.
const WAVEFORM_MAX_POINTS = 800

const REPORT_BLOCKS = [
    { key: 'baseline1_closed', label: 'Baseline 1 — Eyes Closed', kind: 'single', phase: 'baseline1_closed' },
    { key: 'baseline1_open', label: 'Baseline 1 — Eyes Open', kind: 'single', phase: 'baseline1_open' },
    // No single phase marker covers images+math together (confirmed gap in the phase vocabulary) —
    // defined as everything between "images about to start" and "math questions have just finished".
    { key: 'cognitive_task', label: 'Cognitive Task', kind: 'span', fromPhase: 'countdown_images', toPhase: 'countdown_post' },
    { key: 'baseline2_closed', label: 'Baseline 2 — Eyes Closed', kind: 'single', phase: 'baseline2_closed' },
    { key: 'baseline2_open', label: 'Baseline 2 — Eyes Open', kind: 'single', phase: 'baseline2_open' },
]

// Resolves each phase event's [start, end) window. hidden_at is the normal case; if it's missing
// (session ended before the frontend wrote it), fall back to the next phase event's shown_at, and
// if there is no next event at all, to the fixed-duration table above.
function resolvePhaseWindows(phaseEvents) {
    const windows = {}
    for (let i = 0; i < phaseEvents.length; i++) {
        const ev = phaseEvents[i]
        const start = new Date(ev.shown_at)
        let end
        if (ev.hidden_at) end = new Date(ev.hidden_at)
        else if (phaseEvents[i + 1]) end = new Date(phaseEvents[i + 1].shown_at)
        else end = new Date(start.getTime() + (PHASE_FALLBACK_SECONDS[ev.phase] ?? 5) * 1000)
        windows[ev.phase] = { start, end }
    }
    return windows
}

function downsample(points, maxPoints) {
    if (points.length <= maxPoints) return points
    const stride = Math.ceil(points.length / maxPoints)
    const out = []
    for (let i = 0; i < points.length; i += stride) out.push(points[i])
    return out
}

function average(values) {
    const valid = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v))
    if (valid.length === 0) return null
    return valid.reduce((a, b) => a + b, 0) / valid.length
}

function calculateAge(dob) {
    if (!dob) return null
    const birth = new Date(dob)
    const now = new Date()
    let age = now.getFullYear() - birth.getFullYear()
    const m = now.getMonth() - birth.getMonth()
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--
    return age
}

/**
 * Assembles everything pdf/sessionReport.pdf.js needs for one session: patient header, and one
 * block per EEG-state phase (waveform snapshot, alpha-only POWER table, per-channel frequency
 * spectra, absolute-band table). A block with `available: false` means its phase marker(s) weren't
 * found in `events` at all (e.g. a session recorded before the 13-step protocol existed) — the PDF
 * layer renders a "no data" placeholder for it rather than a fabricated chart.
 */
async function buildSessionReportData(sessionId, dbClient) {
    const sessions = await sessionModel.findById(sessionId, dbClient)
    if (!sessions || sessions.length === 0) throw new NotFoundError('Session not found')
    const session = sessions[0]

    // Client requirement: the technician's commentary must be published before a report
    // can be produced. Checked here, ahead of the EEG queries, so every way of building
    // a report enforces it.
    if (!session.has_active_commentary)
        throw new ConflictError('Session commentary must be completed before the report can be generated')

    const phaseEvents = await sessionModel.getSessionPhaseEvents(sessionId, dbClient)
    const windows = resolvePhaseWindows(phaseEvents)

    // One query for the whole session's FFT band powers, reused for every block below (averaged in
    // JS by timestamp) — far cheaper than one bounded query per block.
    const fftResult = await sessionModel.getSessionFftBandPowerResults(sessionId, dbClient)
    const fftRows = fftResult.samples

    const blocks = []
    for (const blockDef of REPORT_BLOCKS) {
        const window = blockDef.kind === 'single'
            ? windows[blockDef.phase]
            : (windows[blockDef.fromPhase] && windows[blockDef.toPhase]
                ? { start: windows[blockDef.fromPhase].end, end: windows[blockDef.toPhase].start }
                : null)

        if (!window || window.end <= window.start) {
            blocks.push({ key: blockDef.key, label: blockDef.label, available: false })
            continue
        }

        const eegResult = await sessionModel.getSessionEEGResults(
            { session_id: sessionId, sample_rate: session.sample_rate, start_time: session.start_time, end_time: session.end_time },
            window.start, window.end, 'filtered', dbClient
        )
        const samples = eegResult.samples

        const fftInWindow = fftRows.filter((r) => {
            const t = new Date(r.time)
            return t >= window.start && t < window.end
        })

        const alphaTable = CHANNELS.map((ch) => ({
            channel: ch.label,
            value: average(fftInWindow.map((r) => r[`${ch.bandPrefix}_alpha`])),
        }))

        const absoluteTable = CHANNELS.map((ch) => {
            const row = { channel: ch.label }
            let total = 0
            let anyValid = false
            for (const band of BANDS) {
                const v = average(fftInWindow.map((r) => r[`${ch.bandPrefix}_${band}`]))
                row[band] = v
                if (v !== null) { total += v; anyValid = true }
            }
            row.total = anyValid ? total : null
            return row
        })

        const spectra = CHANNELS.map((ch) => ({
            channel: ch.label,
            points: computePowerSpectrum(samples.map((s) => s[ch.sampleKey]), session.sample_rate, 15),
        }))

        const waveform = CHANNELS.map((ch) => ({
            channel: ch.label,
            points: downsample(samples.map((s) => ({ t: s.t_seconds, v: s[ch.sampleKey] })), WAVEFORM_MAX_POINTS),
        }))

        blocks.push({
            key: blockDef.key, label: blockDef.label, available: true,
            windowStart: window.start, windowEnd: window.end,
            alphaTable, absoluteTable, spectra, waveform,
        })
    }

    return {
        patient: {
            name: session.client_name,
            age: calculateAge(session.client_dob),
            gender: session.client_gender,
        },
        session: {
            sessionId,
            startTime: session.start_time,
            endTime: session.end_time,
            technicianName: session.technician_name,
        },
        blocks,
    }
}

export default { buildSessionReportData }
